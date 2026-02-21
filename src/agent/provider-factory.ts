// src/agent/provider-factory.ts
// ============================================================
// Provider Factory — Tạo provider dựa trên AGENT_PROVIDER env
// ============================================================

import type { AgentProvider, CompletionProvider } from "./types.ts";
import { ClaudeProvider } from "./providers/claude.ts";

export type ProviderName = "claude" | "openai" | "gemini" | "ollama" | "deepseek";

export async function createProvider(name: ProviderName): Promise<AgentProvider & CompletionProvider> {
  switch (name) {
    case "claude":
      return new ClaudeProvider();
    case "openai": {
      const { OpenAIProvider } = await import("./providers/openai.ts");
      return new OpenAIProvider();
    }
    case "gemini": {
      const { GeminiProvider } = await import("./providers/gemini.ts");
      return new GeminiProvider();
    }
    case "ollama": {
      const { OllamaProvider } = await import("./providers/ollama.ts");
      return new OllamaProvider();
    }
    case "deepseek": {
      const { DeepSeekProvider } = await import("./providers/deepseek.ts");
      return new DeepSeekProvider();
    }
    default:
      throw new Error(
        `Unknown provider: "${name}". Supported: claude, openai, gemini, ollama, deepseek`,
      );
  }
}
