// src/memory/entities.ts
// ============================================================
// Entity graph — trích entity từ nội dung đã lưu và nối chúng lại
// ============================================================
// Dùng Haiku qua CompletionProvider sẵn có (bản Rust dùng provider pool).
// Mỗi entity (người / project / công nghệ / khái niệm / tổ chức) được lưu một
// lần, còn mỗi lần xuất hiện là một dòng entity_mentions trỏ về nguồn.
//
// Trích entity lỗi hoặc model trả rác → bỏ qua im lặng, không chặn việc lưu.
// ============================================================

import { db } from "../db/connection.ts";
import { getClaudeProvider } from "../claude/provider.ts";
import { logger } from "../logger.ts";

const ENTITY_TYPES = ["person", "project", "technology", "concept", "organization"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const MAX_INPUT_CHARS = 3000;
const CONTEXT_WINDOW = 100;

const EXTRACTION_PROMPT = `Bạn là bộ trích xuất entity. Đọc văn bản và trả về CHỈ một JSON array, mỗi phần tử có "name" và "type".

Loại hợp lệ: person, project, technology, concept, organization

Quy tắc:
- Chỉ lấy entity có tên riêng rõ ràng, bỏ qua từ chung chung
- Chuẩn hóa cách viết hoa
- Không có gì thì trả về []
- CHỈ trả JSON array, không thêm chữ nào khác

Ví dụ: [{"name": "Bun", "type": "technology"}, {"name": "BasoTien", "type": "project"}]`;

export interface EntityMention {
  sourceType: string;
  sourceId: number;
  context: string;
}

export interface EntityWithMentions {
  id: number;
  name: string;
  entityType: string;
  mentions: EntityMention[];
}

// --- CRUD ---

export function saveEntity(userId: number, name: string, entityType: string): number {
  db.run(
    `INSERT OR IGNORE INTO entities (user_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)`,
    [userId, name, entityType, Date.now()],
  );
  const row = db
    .query(`SELECT id FROM entities WHERE user_id = ? AND name = ? AND entity_type = ?`)
    .get(userId, name, entityType) as any;
  return row.id;
}

export function addEntityMention(
  entityId: number,
  sourceType: string,
  sourceId: number,
  context: string,
): void {
  db.run(
    `INSERT OR IGNORE INTO entity_mentions (entity_id, source_type, source_id, context, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [entityId, sourceType, sourceId, context, Date.now()],
  );
}

export function searchEntities(userId: number, keyword: string, limit = 10): EntityWithMentions[] {
  const entities = db
    .query(
      `SELECT id, name, entity_type FROM entities
       WHERE user_id = ? AND name LIKE ?
       ORDER BY name LIMIT ?`,
    )
    .all(userId, `%${keyword}%`, limit) as any[];

  return entities.map((e) => ({
    id: e.id,
    name: e.name,
    entityType: e.entity_type,
    mentions: db
      .query(
        `SELECT source_type, source_id, context FROM entity_mentions
         WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10`,
      )
      .all(e.id)
      .map((m: any) => ({
        sourceType: m.source_type,
        sourceId: m.source_id,
        context: m.context,
      })),
  }));
}

export function countEntities(userId: number): number {
  const row = db.query(`SELECT COUNT(*) as c FROM entities WHERE user_id = ?`).get(userId) as any;
  return row.c;
}

// --- Trích xuất ---

/** Lấy đoạn văn bản quanh vị trí entity xuất hiện, để hiển thị khi search. */
export function buildContextSnippet(text: string, name: string): string {
  const idx = text.toLowerCase().indexOf(name.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - CONTEXT_WINDOW / 2);
  const snippet = text.slice(start, start + CONTEXT_WINDOW).replace(/\s+/g, " ").trim();
  return start > 0 ? `...${snippet}` : snippet;
}

/** Parse JSON array từ output của model, bỏ qua phần tử sai định dạng. */
export function parseEntities(response: string): { name: string; type: EntityType }[] {
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is { name: string; type: EntityType } =>
        e &&
        typeof e.name === "string" &&
        e.name.trim().length > 0 &&
        ENTITY_TYPES.includes(e.type),
    );
  } catch {
    return [];
  }
}

/**
 * Trích entity từ text và nối vào nguồn (document hoặc fact).
 * Trả về số entity đã lưu; 0 khi không trích được gì.
 */
export async function extractAndLinkEntities(
  userId: number,
  sourceType: "document" | "fact",
  sourceId: number,
  text: string,
): Promise<number> {
  try {
    const input = text.slice(0, MAX_INPUT_CHARS);
    const response = await getClaudeProvider().complete({
      prompt: input,
      systemPrompt: EXTRACTION_PROMPT,
    });

    const entities = parseEntities(response);
    for (const e of entities) {
      const entityId = saveEntity(userId, e.name.trim(), e.type);
      addEntityMention(entityId, sourceType, sourceId, buildContextSnippet(text, e.name));
    }
    if (entities.length > 0) {
      logger.log(`🏷 Entity: trích ${entities.length} từ ${sourceType} #${sourceId}`);
    }
    return entities.length;
  } catch (error) {
    logger.warn("⚠️ Trích entity lỗi:", error instanceof Error ? error.message : error);
    return 0;
  }
}
