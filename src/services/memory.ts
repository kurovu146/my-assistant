// src/services/memory.ts
// ============================================================
// Memory Service — Fact extraction + Prompt injection
// ============================================================
//
// Tier 1: Passive fact extraction
// → Sau mỗi conversation, dùng Claude (haiku) extract facts
// → Facts lưu vào SQLite để inject vào prompt sau
//
// Tier 2: Active memory via MCP tools (memory-mcp.ts)
// → Claude chủ động gọi memory_save, memory_search...
// ============================================================

import { getCompletionProvider } from "../agent/provider-registry.ts";
import { getUserFacts, saveFact, type MemoryFact } from "../storage/db.ts";
import { logger } from "../logger.ts";

// --- Fact Extraction (Tier 1) ---

const EXTRACT_PROMPT = `Bạn là bộ trích xuất thông tin. Phân tích cuộc hội thoại và trích xuất các facts quan trọng cần nhớ.

Quy tắc:
- Chỉ trích xuất thông tin CỤ THỂ, hữu ích cho các cuộc hội thoại sau
- Bỏ qua thông tin tạm thời (trạng thái hiện tại, lỗi đang fix...)
- Ưu tiên: sở thích, quyết định, kiến trúc, conventions, tên/thông tin cá nhân
- Categories: preference, decision, personal, technical, project, workflow
- Trả về JSON array, mỗi item: {"fact": "...", "category": "..."}
- Nếu KHÔNG có gì đáng nhớ, trả về []
- Tối đa 5 facts mỗi lần

Ví dụ output:
[
  {"fact": "Anh thích dùng Bun thay vì Node.js", "category": "preference"},
  {"fact": "Project BasoTien dùng Go + Godot Engine", "category": "project"}
]`;

/**
 * Trích xuất facts từ cuộc hội thoại.
 * Chạy async sau khi response đã gửi cho user (không block).
 */
export async function extractFacts(
  userId: number,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  try {
    // Skip nếu message quá ngắn (chào hỏi, ok, ...)
    if (userMessage.length < 20 && assistantResponse.length < 100) return;

    // Truncate để tiết kiệm tokens
    const truncatedUser = userMessage.slice(0, 500);
    const truncatedAssistant = assistantResponse.slice(0, 1000);

    const conversationContext = `User: ${truncatedUser}\n\nAssistant: ${truncatedAssistant}`;

    const resultText = await getCompletionProvider().complete({
      prompt: conversationContext,
      systemPrompt: EXTRACT_PROMPT,
    });

    if (!resultText) return;

    // Parse JSON — tìm array trong response
    const jsonMatch = resultText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return; // malformed JSON — skip silently
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    const facts = parsed as Array<{ fact: string; category: string }>;

    // Lưu facts vào DB
    const source = userMessage.slice(0, 50);
    for (const f of facts.slice(0, 5)) {
      if (f.fact && f.fact.length > 5) {
        saveFact(userId, f.fact, f.category || "general", source);
      }
    }

    if (facts.length > 0) {
      logger.log(`🧠 Memory: extracted ${facts.length} facts for user ${userId}`);
    }
  } catch (error) {
    // Silent fail — extraction là optional, không nên ảnh hưởng UX
    logger.error("⚠️ Memory extraction error:", error instanceof Error ? error.message : error);
  }
}

// --- Prompt Injection (inject memory vào prompt) ---

const DECAY_THRESHOLD_DAYS = 30; // Facts > 30 ngày không truy cập → giảm priority

/**
 * Tính relevance score cho fact.
 * Kết hợp: recency + frequency + access.
 */
function scoreFact(fact: MemoryFact): number {
  const now = Date.now();
  const daysSinceUpdate = (now - fact.updatedAt) / (1000 * 60 * 60 * 24);
  const daysSinceAccess = fact.lastAccessedAt > 0
    ? (now - fact.lastAccessedAt) / (1000 * 60 * 60 * 24)
    : daysSinceUpdate;

  // Base score: newer = higher
  let score = Math.max(0, 100 - daysSinceUpdate);

  // Frequency boost: hay truy cập = quan trọng
  score += Math.min(fact.accessCount * 5, 50);

  // Decay penalty: quá lâu không truy cập
  if (daysSinceAccess > DECAY_THRESHOLD_DAYS) {
    score *= 0.5;
  }

  return score;
}

/**
 * Build memory context string để inject vào prompt.
 * Facts được ranked theo relevance score (recency + frequency + decay).
 */
export function buildMemoryContext(userId: number): string {
  const facts = getUserFacts(userId, 50);
  if (facts.length === 0) return "";

  // Score and sort
  const scored = facts
    .map((f) => ({ fact: f, score: scoreFact(f) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30); // Top 30 relevant facts

  // Group by category
  const grouped = new Map<string, MemoryFact[]>();
  for (const { fact } of scored) {
    const list = grouped.get(fact.category) || [];
    list.push(fact);
    grouped.set(fact.category, list);
  }

  let context = "\n\n--- MEMORY (facts đã ghi nhớ về user) ---\n";
  for (const [category, categoryFacts] of grouped) {
    context += `\n[${category}]\n`;
    for (const f of categoryFacts) {
      context += `- ${f.fact}\n`;
    }
  }
  context += "\n--- END MEMORY ---\n";
  context += "Sử dụng thông tin trên để cá nhân hóa câu trả lời. Dùng tool memory_save để ghi nhớ thông tin mới quan trọng.\n";

  return context;
}
