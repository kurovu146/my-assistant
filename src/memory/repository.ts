// src/memory/repository.ts
// ============================================================
// Memory Fact Repository — CRUD + FTS5 search
// ============================================================

import { db } from "../db/connection.ts";

export interface MemoryFact {
  id: number;
  userId: number;
  fact: string;
  category: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export function saveFact(
  userId: number,
  fact: string,
  category: string = "general",
  source: string = "",
  // null = fact chung, khớp NULL trong cột `project` (nullable có chủ ý, xem connection.ts)
  project: string | null = null,
): MemoryFact {
  const now = Date.now();

  const existing = db
    .query(`SELECT id FROM memory_facts WHERE user_id = ? AND fact = ?`)
    .get(userId, fact) as any;

  if (existing) {
    // Cập nhật luôn project: nếu không, fact trùng text lưu lại ở project khác sẽ
    // âm thầm giữ nguyên project cũ — record không bao giờ hiện đúng chỗ caller mới
    // định lưu vào.
    db.run(
      `UPDATE memory_facts SET category = ?, source = ?, project = ?, updated_at = ? WHERE id = ?`,
      [category, source, project, now, existing.id],
    );
    return { id: existing.id, userId, fact, category, source, createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0 };
  }

  const result = db.run(
    `INSERT INTO memory_facts (user_id, fact, category, source, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, fact, category, source, project, now, now],
  );
  return {
    id: Number(result.lastInsertRowid),
    userId, fact, category, source,
    createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0,
  };
}

/**
 * Chuyển keyword người dùng thành query FTS5 an toàn.
 *
 * Mỗi token được bọc thành phrase riêng rồi nối bằng OR:
 * - Bọc phrase để ký tự đặc biệt ("email:", "a-b", "AND") không bị hiểu là cú pháp
 * - Nối OR thay vì gộp cả câu thành một cụm, nếu không câu hỏi dài
 *   ("tại sao không dùng Node") sẽ không khớp gì và FTS đóng góp 0 vào điểm hybrid
 */
export function toFtsQuery(keyword: string): string {
  const tokens = keyword
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(" OR ");
}

// Bỏ trống/"" nghĩa là chỉ lấy fact chung — cùng quy ước với getUserFacts.
export function searchFacts(userId: number, keyword: string, limit: number = 20, project: string = ""): MemoryFact[] {
  // FTS5 search — lỗi cú pháp bất ngờ vẫn rơi về LIKE bên dưới
  let ftsRows: any[] = [];
  if (keyword.trim()) {
    try {
      ftsRows = db
        .query(
          `SELECT m.*, bm25(memory_facts_fts) as rank
           FROM memory_facts_fts fts
           JOIN memory_facts m ON m.id = fts.rowid
           WHERE memory_facts_fts MATCH ? AND m.user_id = ? AND (m.project IS NULL OR m.project = ?)
           ORDER BY rank
           LIMIT ?`,
        )
        .all(toFtsQuery(keyword), userId, project, limit) as any[];
    } catch {
      ftsRows = [];
    }
  }

  if (ftsRows.length > 0) {
    const matchedFacts = ftsRows.map(mapFact);
    touchFactsAccess(matchedFacts.map((f) => f.id));
    return enrichWithContext(userId, matchedFacts, limit, project);
  }

  // LIKE fallback
  const likeRows = db
    .query(
      `SELECT * FROM memory_facts
       WHERE user_id = ? AND (project IS NULL OR project = ?) AND (fact LIKE ? OR category LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, project, `%${keyword}%`, `%${keyword}%`, limit) as any[];

  if (likeRows.length > 0) {
    touchFactsAccess(likeRows.map((r: any) => r.id));
  }
  return likeRows.map(mapFact);
}

function enrichWithContext(userId: number, matchedFacts: MemoryFact[], limit: number, project: string): MemoryFact[] {
  const matchedIds = new Set(matchedFacts.map((f) => f.id));
  const enriched: MemoryFact[] = [...matchedFacts];

  const ONE_HOUR = 60 * 60 * 1000;
  // kt: 1 query/seed (bun:sqlite cache prepared statement, DB local nên rẻ)
  //     — gộp bằng window function khi số seed vượt vài chục
  // Không lọc project ở đây thì fact "hàng xóm" của project khác vẫn len vào kết
  // quả dù FTS/LIKE đã chặn đúng — láng giềng chọn theo category+thời gian, không
  // theo project, nên phải tự thêm điều kiện.
  const neighborStmt = db.query(
    `SELECT * FROM memory_facts
     WHERE user_id = ? AND category = ? AND id != ?
       AND (project IS NULL OR project = ?)
       AND created_at BETWEEN ? AND ?
     ORDER BY ABS(created_at - ?) ASC
     LIMIT 2`,
  );

  for (const fact of matchedFacts) {
    const neighbors = neighborStmt.all(
      userId, fact.category, fact.id, project,
      fact.createdAt - ONE_HOUR, fact.createdAt + ONE_HOUR, fact.createdAt,
    ) as any[];

    for (const n of neighbors) {
      if (!matchedIds.has(n.id)) {
        matchedIds.add(n.id);
        enriched.push(mapFact(n));
      }
    }
  }

  return enriched.slice(0, limit);
}

// Bỏ trống/"" nghĩa là chỉ lấy fact chung (project IS NULL) — KHÔNG giống quy ước
// của sessions/active_sessions (project="" nghĩa là "chưa chọn project"). Hai bảng
// dùng hai quy ước khác nhau vì memory_facts cần biểu diễn "đúng với mọi project",
// còn sessions chỉ cần biểu diễn "chưa gắn project nào".
export function getUserFacts(userId: number, limit: number = 50, project: string = ""): MemoryFact[] {
  const rows = db
    .query(
      `SELECT * FROM memory_facts WHERE user_id = ? AND (project IS NULL OR project = ?)
       ORDER BY
         CASE WHEN access_count > 0 THEN 1 ELSE 0 END DESC,
         updated_at DESC
       LIMIT ?`,
    )
    .all(userId, project, limit) as any[];
  return rows.map(mapFact);
}

function touchFactsAccess(factIds: number[]): void {
  if (factIds.length === 0) return;
  const placeholders = factIds.map(() => "?").join(",");
  db.run(
    `UPDATE memory_facts SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id IN (${placeholders})`,
    [Date.now(), ...factIds],
  );
}

export function getFactById(userId: number, factId: number): MemoryFact | null {
  const row = db
    .query(`SELECT * FROM memory_facts WHERE id = ? AND user_id = ?`)
    .get(factId, userId) as any;
  return row ? mapFact(row) : null;
}

// --- Embedding & relations (dữ liệu thuần; logic ở semantic.ts) ---

export function updateFactEmbedding(factId: number, embedding: Uint8Array): void {
  db.run(`UPDATE memory_facts SET embedding = ? WHERE id = ?`, [embedding, factId]);
}

export interface FactEmbedding {
  id: number;
  fact: string;
  category: string;
  embedding: Uint8Array;
}

/**
 * `project` để `undefined` (mặc định) → không lọc, giữ nguyên hành vi cho
 * `embedAndLinkFact`/`backfillFactEmbeddings` (tự liên kết fact tương tự trong
 * TOÀN BỘ facts của user, không riêng project nào). Chỉ `searchFactsHybrid`
 * truyền `project` để nhánh vector không lộ fact của project khác.
 */
export function loadAllFactEmbeddings(userId: number, project?: string): FactEmbedding[] {
  const rows = (
    project === undefined
      ? db
          .query(
            `SELECT id, fact, category, embedding FROM memory_facts
             WHERE user_id = ? AND embedding IS NOT NULL`,
          )
          .all(userId)
      : db
          .query(
            `SELECT id, fact, category, embedding FROM memory_facts
             WHERE user_id = ? AND (project IS NULL OR project = ?) AND embedding IS NOT NULL`,
          )
          .all(userId, project)
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    fact: r.fact,
    category: r.category,
    embedding: new Uint8Array(r.embedding),
  }));
}

export function getUnembeddedFacts(userId: number): { id: number; fact: string }[] {
  return db
    .query(`SELECT id, fact FROM memory_facts WHERE user_id = ? AND embedding IS NULL`)
    .all(userId) as { id: number; fact: string }[];
}

/** Liên kết 2 fact. Bảng ràng buộc fact_id_1 < fact_id_2 nên phải sắp trước khi ghi. */
export function linkFacts(idA: number, idB: number, similarity: number): void {
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  db.run(
    `INSERT INTO fact_relations (fact_id_1, fact_id_2, similarity, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (fact_id_1, fact_id_2) DO UPDATE SET similarity = excluded.similarity`,
    [lo, hi, similarity, Date.now()],
  );
}

export interface RelatedFact {
  id: number;
  fact: string;
  category: string;
  similarity: number;
}

// Bỏ trống/"" nghĩa là chỉ lấy fact chung — cùng quy ước với getUserFacts. Quan hệ
// cũ (tạo trước khi có lọc này, hoặc tạo bởi consolidation) có thể trỏ sang fact của
// project khác — lọc ở đây để dữ liệu liên kết cũ đó không tiếp tục lộ ra ngoài.
export function getRelatedFacts(factId: number, limit = 3, project: string = ""): RelatedFact[] {
  return db
    .query(
      `SELECT m.id, m.fact, m.category, r.similarity
       FROM fact_relations r
       JOIN memory_facts m
         ON m.id = CASE WHEN r.fact_id_1 = ?1 THEN r.fact_id_2 ELSE r.fact_id_1 END
       WHERE (r.fact_id_1 = ?1 OR r.fact_id_2 = ?1)
         AND (m.project IS NULL OR m.project = ?3)
       ORDER BY r.similarity DESC
       LIMIT ?2`,
    )
    .all(factId, limit, project) as RelatedFact[];
}

// Bỏ trống/"" nghĩa là chỉ lấy fact chung — cùng quy ước với getUserFacts.
export function getFactsByCategory(userId: number, category: string, project: string = ""): MemoryFact[] {
  const rows = db
    .query(
      `SELECT * FROM memory_facts
       WHERE user_id = ? AND category = ? AND (project IS NULL OR project = ?)
       ORDER BY updated_at DESC`,
    )
    .all(userId, category, project) as any[];
  return rows.map(mapFact);
}

export function deleteFact(userId: number, factId: number): boolean {
  const result = db.run(
    `DELETE FROM memory_facts WHERE id = ? AND user_id = ?`,
    [factId, userId],
  );
  return result.changes > 0;
}

// Bỏ trống/"" nghĩa là chỉ đếm fact chung — cùng quy ước với getUserFacts.
export function countFacts(userId: number, project: string = ""): number {
  const row = db
    .query(`SELECT COUNT(*) as cnt FROM memory_facts WHERE user_id = ? AND (project IS NULL OR project = ?)`)
    .get(userId, project) as any;
  return row.cnt;
}

function mapFact(r: any): MemoryFact {
  return {
    id: r.id, userId: r.user_id, fact: r.fact, category: r.category,
    source: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at || 0, accessCount: r.access_count || 0,
  };
}

// Cleanup operations
export interface CleanupResult {
  logsDeleted: number;
  sessionsDeleted: number;
}

export function cleanupOldData(): CleanupResult {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const logsResult = db.run(`DELETE FROM query_logs WHERE created_at < ?`, [ninetyDaysAgo]);
  const sessionsResult = db.run(
    `DELETE FROM sessions
     WHERE last_active_at < ?
       AND (user_id, session_id) NOT IN (
         SELECT user_id, session_id FROM active_sessions
       )`,
    [thirtyDaysAgo],
  );

  return { logsDeleted: logsResult.changes, sessionsDeleted: sessionsResult.changes };
}
