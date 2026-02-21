// src/agent/router.ts
// ============================================================
// Model Router — Generic tier system + inline override parser
// ============================================================
// Tiers: fast / balanced / powerful
// Backward compat: "dùng opus" → tier "powerful"

import { config } from "../config.ts";

export type ModelTier = "fast" | "balanced" | "powerful";

// Alias map: tên cũ (Claude-specific) → tier mới
const TIER_ALIASES: Record<string, ModelTier> = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "powerful",
  fast: "fast",
  balanced: "balanced",
  powerful: "powerful",
};

// Model tiers per provider
const MODEL_TIERS: Record<string, Record<ModelTier, string>> = {
  claude: {
    fast: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    powerful: "claude-opus-4-6",
  },
  openai: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    powerful: "gpt-4o",
  },
  gemini: {
    fast: "gemini-2.0-flash",
    balanced: "gemini-2.5-pro",
    powerful: "gemini-2.5-pro",
  },
  ollama: {
    fast: "llama3.1",
    balanced: "llama3.1",
    powerful: "llama3.1:70b",
  },
  deepseek: {
    fast: "deepseek-chat",
    balanced: "deepseek-chat",
    powerful: "deepseek-reasoner",
  },
};

/** Resolve tier name → actual model ID cho provider hiện tại */
export function resolveModelTier(tier: ModelTier): string {
  const providerTiers = MODEL_TIERS[config.agentProvider];
  if (!providerTiers) return "";
  return providerTiers[tier] || "";
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
