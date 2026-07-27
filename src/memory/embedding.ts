// src/memory/embedding.ts
// ============================================================
// Embedding — Voyage AI client + vector helpers
// ============================================================
// Toàn bộ lớp semantic là TÙY CHỌN: không có VOYAGE_API_KEY thì
// getEmbeddingClient() trả null và mọi caller rơi về FTS5 thuần.
//
// Định dạng BLOB (little-endian f32) giữ giống bản Rust ở
// ~/Dev/memory-assistant để hai bot đọc được dữ liệu của nhau.
// ============================================================

import { config } from "../config.ts";
import { logger } from "../logger.ts";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_BATCH = 128;

export type InputType = "document" | "query";

export class EmbeddingClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  /** Embed nhiều text một lần. Trả mảng vector cùng thứ tự input. */
  async embedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > MAX_BATCH) {
      throw new Error(`embedBatch: tối đa ${MAX_BATCH} text mỗi lần (nhận ${texts.length})`);
    }

    const resp = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts, input_type: inputType }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Voyage API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }

    const json = (await resp.json()) as { data?: { embedding: number[] }[] };
    return (json.data || []).map((d) => d.embedding);
  }

  /** Embed 1 câu truy vấn. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text], "query");
    if (!vector) throw new Error("Voyage trả về rỗng");
    return vector;
  }
}

// --- Singleton ---

let client: EmbeddingClient | null = null;
let checked = false;

/** Trả null khi chưa cấu hình VOYAGE_API_KEY — caller phải xử lý được trường hợp này. */
export function getEmbeddingClient(): EmbeddingClient | null {
  if (!checked) {
    checked = true;
    if (config.voyageApiKey) {
      client = new EmbeddingClient(config.voyageApiKey, config.voyageModel);
      logger.log(`🧬 Embedding: Voyage (${config.voyageModel})`);
    } else {
      logger.log("🧬 Embedding: tắt (thiếu VOYAGE_API_KEY) — chỉ dùng FTS5");
    }
  }
  return client;
}

// --- Vector helpers ---

/** f32 little-endian, cùng định dạng với bản Rust. */
export function embeddingToBytes(embedding: number[]): Uint8Array {
  const buf = new ArrayBuffer(embedding.length * 4);
  const view = new DataView(buf);
  embedding.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return new Uint8Array(buf);
}

export function bytesToEmbedding(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4) out.push(view.getFloat32(i, true));
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Gộp điểm FTS và vector — công thức dùng chung cho facts và knowledge chunks.
 * Không có kết quả vector nào → FTS quyết định hoàn toàn.
 */
export function hybridScore(ftsScore: number, vectorScore: number, hasVectors: boolean): number {
  return hasVectors ? 0.4 * ftsScore + 0.6 * vectorScore : ftsScore;
}
