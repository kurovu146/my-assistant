// src/memory/knowledge.ts
// ============================================================
// Knowledge base — tài liệu dài, chunk + embed, hybrid search
// ============================================================
// Khác memory_facts (một câu ngắn): đây là bài viết / note / tài liệu.
// Doc được cắt thành chunk ~1000 ký tự theo ranh giới đoạn văn, mỗi chunk
// embed riêng để tìm được đúng đoạn thay vì cả tài liệu.
//
// Thiếu VOYAGE_API_KEY → vẫn lưu và vẫn tìm được bằng FTS5, chỉ mất phần vector.
// ============================================================

import { db } from "../db/connection.ts";
import { logger } from "../logger.ts";
import {
  bytesToEmbedding,
  cosineSimilarity,
  embeddingToBytes,
  getEmbeddingClient,
  hybridScore,
} from "./embedding.ts";
import { toFtsQuery } from "./repository.ts";

const TARGET_CHUNK_SIZE = 1000;
const EMBED_BATCH = 128;
const VECTOR_CANDIDATES = 20;

export interface KnowledgeDoc {
  id: number;
  userId: number;
  title: string;
  content: string;
  source: string;
  tags: string;
  createdAt: number;
}

/**
 * Cắt text thành chunk ~1000 ký tự, không cắt giữa đoạn văn.
 * Đoạn dài hơn giới hạn thì đứng riêng một chunk (không cắt giữa câu).
 */
export function chunkText(text: string, targetSize = TARGET_CHUNK_SIZE): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > targetSize) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// --- Lưu ---

export function insertDocument(
  userId: number,
  title: string,
  content: string,
  source = "",
  tags = "",
): number {
  const result = db.run(
    `INSERT INTO knowledge_documents (user_id, title, content, source, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, title, content, source, tags, Date.now()],
  );
  return Number(result.lastInsertRowid);
}

/**
 * Lưu tài liệu: cắt chunk, ghi DB, embed từng chunk (nếu bật).
 * Trả về id doc và số chunk đã tạo.
 */
export async function saveDocument(
  userId: number,
  title: string,
  content: string,
  source = "",
  tags = "",
): Promise<{ docId: number; chunks: number; embedded: boolean }> {
  const docId = insertDocument(userId, title, content, source, tags);
  const chunks = chunkText(content);
  const now = Date.now();

  chunks.forEach((chunk, i) => {
    db.run(
      `INSERT INTO knowledge_chunks (doc_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?)`,
      [docId, i, chunk, now],
    );
  });

  const client = getEmbeddingClient();
  if (!client || chunks.length === 0) return { docId, chunks: chunks.length, embedded: false };

  try {
    const rows = db
      .query(`SELECT id, content FROM knowledge_chunks WHERE doc_id = ? ORDER BY chunk_index`)
      .all(docId) as { id: number; content: string }[];

    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      const vectors = await client.embedBatch(batch.map((r) => r.content), "document");
      batch.forEach((row, idx) => {
        const v = vectors[idx];
        if (v) {
          db.run(`UPDATE knowledge_chunks SET embedding = ? WHERE id = ?`, [
            embeddingToBytes(v),
            row.id,
          ]);
        }
      });
    }
    return { docId, chunks: chunks.length, embedded: true };
  } catch (error) {
    logger.warn("⚠️ Embed chunks lỗi:", error instanceof Error ? error.message : error);
    return { docId, chunks: chunks.length, embedded: false };
  }
}

// --- Tìm ---

export interface KnowledgeHit {
  docId: number;
  title: string;
  chunk: string;
  score: number;
}

/**
 * Hybrid search trên chunk: FTS5 + cosine, cùng công thức 0.4/0.6 như facts.
 * Mỗi doc chỉ trả về chunk khớp nhất.
 */
export async function searchKnowledge(
  userId: number,
  keyword: string,
  limit = 5,
): Promise<KnowledgeHit[]> {
  const scores = new Map<number, { docId: number; title: string; chunk: string; fts: number; vector: number }>();

  // FTS5 trên chunk
  if (keyword.trim()) {
    try {
      const rows = db
        .query(
          `SELECT c.id, c.doc_id, c.content, d.title
           FROM knowledge_chunks_fts f
           JOIN knowledge_chunks c ON c.id = f.rowid
           JOIN knowledge_documents d ON d.id = c.doc_id
           WHERE knowledge_chunks_fts MATCH ? AND d.user_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(toFtsQuery(keyword), userId, limit * 4) as any[];

      rows.forEach((r, i) => {
        scores.set(r.id, {
          docId: r.doc_id,
          title: r.title,
          chunk: r.content,
          fts: 1 - i / rows.length,
          vector: 0,
        });
      });
    } catch {
      // FTS lỗi cú pháp → bỏ qua, còn vector
    }
  }

  const client = getEmbeddingClient();
  if (client) {
    try {
      const queryVector = await client.embedQuery(keyword);
      const rows = db
        .query(
          `SELECT c.id, c.doc_id, c.content, c.embedding, d.title
           FROM knowledge_chunks c
           JOIN knowledge_documents d ON d.id = c.doc_id
           WHERE d.user_id = ? AND c.embedding IS NOT NULL`,
        )
        .all(userId) as any[];

      const scored = rows
        .map((r) => ({
          r,
          sim: cosineSimilarity(queryVector, bytesToEmbedding(new Uint8Array(r.embedding))),
        }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, VECTOR_CANDIDATES);

      const maxSim = scored[0]?.sim ?? 0;
      if (maxSim > 0) {
        for (const { r, sim } of scored) {
          const normalized = sim / maxSim;
          const existing = scores.get(r.id);
          if (existing) {
            existing.vector = normalized;
          } else {
            scores.set(r.id, {
              docId: r.doc_id,
              title: r.title,
              chunk: r.content,
              fts: 0,
              vector: normalized,
            });
          }
        }
      }
    } catch (error) {
      logger.warn("⚠️ KB vector search lỗi:", error instanceof Error ? error.message : error);
    }
  }

  const hasVectors = [...scores.values()].some((s) => s.vector > 0);
  const ranked = [...scores.values()]
    .map((s) => ({
      docId: s.docId,
      title: s.title,
      chunk: s.chunk,
      score: hybridScore(s.fts, s.vector, hasVectors),
    }))
    .sort((a, b) => b.score - a.score);

  // Mỗi doc chỉ giữ chunk điểm cao nhất
  const seen = new Set<number>();
  return ranked.filter((h) => !seen.has(h.docId) && seen.add(h.docId)).slice(0, limit);
}

export function listDocuments(userId: number, limit = 20): KnowledgeDoc[] {
  const rows = db
    .query(
      `SELECT id, user_id, title, content, source, tags, created_at
       FROM knowledge_documents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    content: r.content,
    source: r.source,
    tags: r.tags,
    createdAt: r.created_at,
  }));
}

export function countDocuments(userId: number): number {
  const row = db
    .query(`SELECT COUNT(*) as c FROM knowledge_documents WHERE user_id = ?`)
    .get(userId) as any;
  return row.c;
}

export function deleteDocument(userId: number, docId: number): boolean {
  const result = db.run(`DELETE FROM knowledge_documents WHERE id = ? AND user_id = ?`, [
    docId,
    userId,
  ]);
  return result.changes > 0;
}

/** Liên kết fact với tài liệu nguồn */
export function linkFactToDoc(factId: number, docId: number): void {
  db.run(
    `INSERT OR IGNORE INTO memory_kb_links (fact_id, doc_id, created_at) VALUES (?, ?, ?)`,
    [factId, docId, Date.now()],
  );
}
