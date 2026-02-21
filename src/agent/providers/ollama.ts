// src/agent/providers/ollama.ts
// ============================================================
// Ollama Provider — Local LLM via OpenAI-compatible API
// ============================================================

import { config } from "../../config.ts";
import { BaseChatProvider } from "./base-chat.ts";

export class OllamaProvider extends BaseChatProvider {
  readonly name = "ollama";

  protected getBaseUrl(): string {
    return config.agentBaseUrl || "http://localhost:11434/v1/chat/completions";
  }

  protected getHeaders(): Record<string, string> {
    // Ollama không cần API key
    return {};
  }

  protected getDefaultModel(): string {
    return config.agentModel || "llama3.1";
  }

  // Override auth check — Ollama chỉ cần test connection
  override async checkAuth(): Promise<{ ok: boolean; message: string }> {
    try {
      const baseUrl = this.getBaseUrl().replace("/v1/chat/completions", "");
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        return { ok: true, message: "✅ Ollama server connected" };
      }
      return { ok: false, message: `❌ Ollama server returned ${response.status}` };
    } catch {
      return {
        ok: false,
        message: "❌ Không kết nối được Ollama. Chạy: ollama serve",
      };
    }
  }
}
