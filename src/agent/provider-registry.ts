// src/agent/provider-registry.ts
// ============================================================
// Provider Registry — Singleton access cho active provider
// ============================================================

import type { AgentProvider, CompletionProvider } from "./types.ts";

let provider: (AgentProvider & CompletionProvider) | null = null;

export function registerProvider(p: AgentProvider & CompletionProvider): void {
  provider = p;
  console.log(`🔌 Provider registered: ${p.name}`);
}

export function getAgentProvider(): AgentProvider {
  if (!provider) {
    throw new Error("Agent provider chưa được khởi tạo. Gọi registerProvider() trước.");
  }
  return provider;
}

export function getCompletionProvider(): CompletionProvider {
  if (!provider) {
    throw new Error("Completion provider chưa được khởi tạo. Gọi registerProvider() trước.");
  }
  return provider;
}
