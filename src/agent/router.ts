// src/agent/router.ts
// Model override parser — detect "dùng opus/sonnet/haiku" prefix

export type ModelTier = "haiku" | "sonnet" | "opus";

/** Parse inline model override from message text */
export function parseModelOverride(text: string): { tier: ModelTier; rest: string } | null {
  const match = text.match(/^(?:dùng|dung|use)\s+(opus|sonnet|haiku)\s*/i);
  if (!match) return null;
  const tier = match[1]!.toLowerCase() as ModelTier;
  const rest = text.slice(match[0].length).trim();
  return { tier, rest };
}
