// src/agent/router.ts
// ============================================================
// Model Router — Claude tier system + inline override parser
// ============================================================

export type ModelTier = "fast" | "balanced" | "powerful";

// Alias map: tên cũ → tier
const TIER_ALIASES: Record<string, ModelTier> = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "powerful",
  fast: "fast",
  balanced: "balanced",
  powerful: "powerful",
};

const CLAUDE_TIERS: Record<ModelTier, string> = {
  fast: "claude-haiku-4-5",
  balanced: "claude-sonnet-5",
  powerful: "claude-opus-5",
};

/** Nhãn hiển thị trên nút bấm và trong /status */
export const TIER_LABELS: Record<ModelTier, string> = {
  fast: "⚡ Haiku (nhanh, rẻ)",
  balanced: "⚖️ Sonnet (cân bằng)",
  powerful: "🧠 Opus (mạnh nhất)",
};

/** Resolve tier name → actual Claude model ID */
export function resolveModelTier(tier: ModelTier): string {
  return CLAUDE_TIERS[tier] || "";
}

/** Alias user gõ ("opus", "fast"...) → tier, hoặc null nếu không nhận ra */
export function parseTier(raw: string): ModelTier | null {
  return TIER_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** Model ID → tier, để hiển thị nhãn. null nếu là model lạ (env tự đặt) */
export function tierOfModel(model: string): ModelTier | null {
  const found = Object.entries(CLAUDE_TIERS).find(([, id]) => id === model);
  return found ? (found[0] as ModelTier) : null;
}

/** Parse inline model override from message text */
export function parseModelOverride(text: string): { tier: ModelTier; rest: string } | null {
  // Match: "dùng opus ...", "use fast ...", "dùng powerful ..."
  const match = text.match(
    /^(?:dùng|dung|use)\s+(opus|sonnet|haiku|fast|balanced|powerful)\s*/i,
  );
  if (!match) return null;

  const raw = match[1]!.toLowerCase();
  const tier = TIER_ALIASES[raw];
  if (!tier) return null;

  const rest = text.slice(match[0].length).trim();
  return { tier, rest };
}
