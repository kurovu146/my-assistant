// src/agent/provider-factory.ts
// ============================================================
// Provider Factory — Tạo ClaudeProvider
// ============================================================

import type { AgentProvider, CompletionProvider } from "./types.ts";
import { ClaudeProvider } from "./providers/claude.ts";

export async function createProvider(): Promise<AgentProvider & CompletionProvider> {
  return new ClaudeProvider();
}
