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
  fast: "claude-haiku-4-5-20251001",
  balanced: "claude-sonnet-4-6",
  powerful: "claude-opus-4-6",
};

/** Resolve tier name → actual Claude model ID */
export function resolveModelTier(tier: ModelTier): string {
  return CLAUDE_TIERS[tier] || "";
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
