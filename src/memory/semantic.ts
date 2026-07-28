// src/memory/semantic.ts
// ============================================================
// Semantic layer cho memory facts
// ============================================================
// - Khi lưu fact: embed rồi tự liên kết các fact tương tự
// - Khi tìm: gộp điểm FTS5 và cosine, kèm fact liên quan
// - Lúc khởi động: backfill vector cho fact cũ
//
// Thiếu VOYAGE_API_KEY → mọi hàm ở đây thành no-op và caller
// dùng kết quả FTS5 như trước.
// ============================================================

import {
  bytesToEmbedding,
  cosineSimilarity,
  embeddingToBytes,
  getEmbeddingClient,
  hybridScore,
} from "./embedding.ts";
import {
  getFactById,
  getRelatedFacts,
  getUnembeddedFacts,
  linkFacts,
  loadAllFactEmbeddings,
  searchFacts,
  updateFactEmbedding,
  type MemoryFact,
} from "./repository.ts";
import { logger } from "../logger.ts";

/** Ngưỡng coi 2 fact là liên quan — lấy từ bản Rust (memory-assistant) */
const RELATION_THRESHOLD = 0.75;
const MAX_RELATIONS_PER_FACT = 3;
const VECTOR_CANDIDATES = 20;
const EMBED_BATCH = 128;

/**
 * Embed 1 fact vừa lưu và liên kết với các fact tương tự.
 * Trả về danh sách fact đã liên kết (rỗng nếu tắt embedding hoặc lỗi).
 *
 * `project` là project của CHÍNH fact đang lưu (null = fact chung — cùng quy ước
 * với `saveFact`), không phải "project hiện tại" của người gọi. Dùng để giới hạn
 * candidate link đúng phạm vi: fact riêng của project A chỉ được link với fact của
 * A hoặc fact chung; fact chung chỉ link với fact chung. Không giới hạn thì mỗi lần
 * lưu fact có thể tự động link (và sau đó lộ nội dung ra qua `getRelatedFacts`) với
 * fact của một project hoàn toàn khác.
 */
export async function embedAndLinkFact(
  userId: number,
  factId: number,
  factText: string,
  project: string | null = null,
): Promise<{ id: number; fact: string; similarity: number }[]> {
  const client = getEmbeddingClient();
  if (!client) return [];

  try {
    const [vector] = await client.embedBatch([factText], "document");
    if (!vector) return [];
    updateFactEmbedding(factId, embeddingToBytes(vector));

    const linked: { id: number; fact: string; similarity: number }[] = [];
    // project=null (fact chung) → "" cho loadAllFactEmbeddings, đúng quy ước
    // "chỉ lấy fact chung" đã dùng ở getUserFacts/searchFacts.
    const candidates = loadAllFactEmbeddings(userId, project ?? "")
      .filter((f) => f.id !== factId)
      .map((f) => ({ ...f, similarity: cosineSimilarity(vector, bytesToEmbedding(f.embedding)) }))
      .filter((f) => f.similarity > RELATION_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, MAX_RELATIONS_PER_FACT);

    for (const c of candidates) {
      linkFacts(factId, c.id, c.similarity);
      linked.push({ id: c.id, fact: c.fact, similarity: c.similarity });
    }
    return linked;
  } catch (error) {
    logger.warn("⚠️ Embed fact lỗi:", error instanceof Error ? error.message : error);
    return [];
  }
}

export interface ScoredFact {
  fact: MemoryFact;
  score: number;
  related: { id: number; fact: string; similarity: number }[];
}

/**
 * Tìm fact bằng FTS5 + vector.
 * Không có embedding → trả đúng kết quả FTS5, thứ tự giữ nguyên.
 */
// Bỏ trống/"" nghĩa là chỉ lấy fact chung — cùng quy ước với getUserFacts/searchFacts.
export async function searchFactsHybrid(
  userId: number,
  keyword: string,
  limit = 20,
  project: string = "",
): Promise<ScoredFact[]> {
  const ftsHits = searchFacts(userId, keyword, limit, project);

  const scores = new Map<number, { fact: MemoryFact; fts: number; vector: number }>();
  ftsHits.forEach((fact, i) => {
    scores.set(fact.id, { fact, fts: 1 - i / ftsHits.length, vector: 0 });
  });

  const client = getEmbeddingClient();
  if (client) {
    try {
      const queryVector = await client.embedQuery(keyword);
      // Phải truyền project ở đây — nếu không fact của project khác vẫn lọt vào
      // qua đường cosine similarity dù nhánh FTS phía trên đã lọc đúng.
      const scored = loadAllFactEmbeddings(userId, project)
        .map((f) => ({ f, sim: cosineSimilarity(queryVector, bytesToEmbedding(f.embedding)) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, VECTOR_CANDIDATES);

      const maxSim = scored[0]?.sim ?? 0;
      if (maxSim > 0) {
        for (const { f, sim } of scored) {
          const normalized = sim / maxSim;
          const existing = scores.get(f.id);
          if (existing) {
            existing.vector = normalized;
          } else {
            // Vector tìm ra fact mà FTS bỏ sót → nạp bản đầy đủ từ DB
            const full = getFactById(userId, f.id);
            if (full) scores.set(f.id, { fact: full, fts: 0, vector: normalized });
          }
        }
      }
    } catch (error) {
      logger.warn("⚠️ Vector search lỗi, dùng FTS:", error instanceof Error ? error.message : error);
    }
  }

  const hasVectors = [...scores.values()].some((s) => s.vector > 0);
  return [...scores.values()]
    .map((s) => ({
      fact: s.fact,
      score: hybridScore(s.fts, s.vector, hasVectors),
      // Truyền project của người gọi — nếu không, fact liên quan của project khác
      // (kể cả quan hệ tạo TRƯỚC khi có filter ở embedAndLinkFact) vẫn lộ ra đây.
      related: getRelatedFacts(s.fact.id, MAX_RELATIONS_PER_FACT, project).map((r) => ({
        id: r.id,
        fact: r.fact,
        similarity: r.similarity,
      })),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Backfill vector cho fact chưa có, rồi tính quan hệ giữa mọi cặp.
 * Chạy nền lúc khởi động; im lặng bỏ qua khi tắt embedding.
 */
export async function backfillFactEmbeddings(userIds: number[]): Promise<void> {
  const client = getEmbeddingClient();
  if (!client) return;

  for (const userId of userIds) {
    const pending = getUnembeddedFacts(userId);
    if (pending.length === 0) continue;

    logger.log(`🧬 Backfill: embedding ${pending.length} facts của user ${userId}...`);
    try {
      for (let i = 0; i < pending.length; i += EMBED_BATCH) {
        const batch = pending.slice(i, i + EMBED_BATCH);
        const vectors = await client.embedBatch(batch.map((f) => f.fact), "document");
        batch.forEach((f, idx) => {
          const v = vectors[idx];
          if (v) updateFactEmbedding(f.id, embeddingToBytes(v));
        });
      }

      // Tính quan hệ cho toàn bộ cặp — O(n²) nhưng n là vài chục fact
      const all = loadAllFactEmbeddings(userId).map((f) => ({
        id: f.id,
        vector: bytesToEmbedding(f.embedding),
      }));
      let links = 0;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const sim = cosineSimilarity(all[i]!.vector, all[j]!.vector);
          if (sim > RELATION_THRESHOLD) {
            linkFacts(all[i]!.id, all[j]!.id, sim);
            links++;
          }
        }
      }
      logger.log(`🧬 Backfill xong user ${userId}: ${all.length} vectors, ${links} liên kết`);
    } catch (error) {
      logger.error("❌ Backfill lỗi:", error instanceof Error ? error.message : error);
    }
  }
}
