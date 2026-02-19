// src/agent/router.ts
// ============================================================
// Smart Routing — Phân loại query và chọn model tối ưu
// ============================================================
//
// Heuristic-based (không dùng LLM pre-classification):
// - Haiku: chào hỏi, cảm ơn, dịch đơn giản
// - Sonnet: default — giải thích, tóm tắt, code vừa
// - Opus: architecture, refactor, debug, research sâu
//
// Inspired by TinyClaw's 8-dimension smart routing.
// ============================================================

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface RouteDecision {
  model: string;
  tier: ModelTier;
  reason: string;
}

const MODELS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

// --- Heuristic Patterns ---

// Tier 1: Haiku — simple greetings, thanks, quick lookups
const HAIKU_PATTERNS = [
  /^(hi|hello|hey|xin chào|chào|alo|yo)\b/i,
  /^(cảm ơn|cám ơn|thanks|thank you|tks|ok|oke|okay|được|ừ|uh huh|good|tốt|nice)\s*[.!]?\s*$/i,
  /^(mấy giờ|what time|hôm nay thứ mấy|today is)\b/i,
  /^(tên em là gì|em là ai|who are you|you are)\b/i,
  /^(dịch|translate|dịch giúm|dịch hộ)\s/i,
  /^(sao rồi|khỏe không|how are you)\b/i,
];

// Tier 3: Opus — complex tasks requiring deep reasoning
const OPUS_KEYWORDS = [
  // Architecture & design
  "thiết kế", "architecture", "design pattern", "system design",
  // Multi-file coding
  "refactor", "restructure", "implement", "triển khai", "viết cho anh",
  // Debugging deep issues
  "debug", "investigate", "tìm bug", "trace", "fix bug",
  // Research & analysis
  "research", "tìm hiểu", "so sánh", "compare", "phân tích chi tiết",
  "đánh giá", "review code", "code review", "audit",
  // Generation
  "tạo project", "scaffold", "boilerplate", "migration",
  // Complex operations
  "optimize", "tối ưu", "performance", "benchmark",
];

// Contextual signals for Opus
const OPUS_SIGNALS: ((prompt: string) => boolean)[] = [
  (p) => p.length > 500,
  (p) => (p.match(/```/g)?.length || 0) >= 2,
  (p) => /\b(nhiều|multiple|all|tất cả)\s+(file|module|component)/i.test(p),
  (p) => /sửa.+file|edit.+file|change.+file/i.test(p),
];

/**
 * Phân loại query và chọn model tối ưu.
 *
 * Ưu tiên:
 * 1. User override ("dùng opus")
 * 2. Session continuity (Opus session → giữ Opus)
 * 3. Heuristic classification
 * 4. Default → Sonnet
 */
export function classifyQuery(
  prompt: string,
  sessionModel?: string,
  userOverride?: ModelTier,
): RouteDecision {
  // 1. User explicit override
  if (userOverride) {
    return { model: MODELS[userOverride], tier: userOverride, reason: "user_override" };
  }

  // 2. Session continuity — don't downgrade mid-conversation
  if (sessionModel?.includes("opus")) {
    return { model: MODELS.opus, tier: "opus", reason: "session_continuity" };
  }

  // 3. Heuristic classification
  const trimmed = prompt.trim();

  // Haiku patterns (simple queries)
  for (const pattern of HAIKU_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { model: MODELS.haiku, tier: "haiku", reason: "simple_query" };
    }
  }

  // Opus keywords
  const lower = trimmed.toLowerCase();
  for (const keyword of OPUS_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return { model: MODELS.opus, tier: "opus", reason: `keyword:${keyword}` };
    }
  }

  // Opus contextual signals
  for (const signal of OPUS_SIGNALS) {
    if (signal(trimmed)) {
      return { model: MODELS.opus, tier: "opus", reason: "complex_signal" };
    }
  }

  // 4. Default: Sonnet
  return { model: MODELS.sonnet, tier: "sonnet", reason: "default" };
}

/** Detect tier from model ID string */
export function detectTier(modelId: string): ModelTier {
  if (modelId.includes("haiku")) return "haiku";
  if (modelId.includes("opus")) return "opus";
  return "sonnet";
}

/** Parse inline model override from message text */
export function parseModelOverride(text: string): { tier: ModelTier; rest: string } | null {
  const match = text.match(/^(?:dùng|dung|use)\s+(opus|sonnet|haiku)\s*/i);
  if (!match) return null;
  const tier = match[1]!.toLowerCase() as ModelTier;
  const rest = text.slice(match[0].length).trim();
  return { tier, rest };
}

export const TIER_LABELS: Record<ModelTier, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};
