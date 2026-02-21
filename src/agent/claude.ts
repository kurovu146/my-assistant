// src/agent/claude.ts
// ============================================================
// Claude Agent — Facade (backward compatibility)
// ============================================================
// Logic đã chuyển sang providers/claude.ts (ClaudeProvider class).
// File này re-export các function cũ để telegram.ts, commands.ts
// không cần thay đổi ngay lập tức.
// ============================================================

import { getAgentProvider } from "./provider-registry.ts";
import type { AgentQueryOptions } from "./types.ts";

// Re-export types (backward compat)
export type {
  UsageStats,
  AgentResponse,
  CumulativeUsage,
  OnProgressCallback,
} from "./types.ts";

/**
 * @deprecated Dùng getAgentProvider().query() thay thế
 */
export async function askClaude(
  prompt: string,
  sessionId?: string,
  onProgress?: AgentQueryOptions["onProgress"],
  abortSignal?: AbortSignal,
  userId?: number,
  modelOverride?: string,
) {
  return getAgentProvider().query({
    prompt,
    sessionId,
    onProgress,
    abortSignal,
    userId,
    modelOverride,
  });
}

/**
 * @deprecated Dùng getAgentProvider().checkAuth() thay thế
 */
export async function checkAuth() {
  return getAgentProvider().checkAuth();
}

/**
 * @deprecated Dùng getAgentProvider().reloadSkills() thay thế
 */
export function reloadSkills() {
  return getAgentProvider().reloadSkills();
}

/**
 * @deprecated Dùng getAgentProvider().getCumulativeUsage() thay thế
 */
export function getCumulativeUsage() {
  return getAgentProvider().getCumulativeUsage();
}
