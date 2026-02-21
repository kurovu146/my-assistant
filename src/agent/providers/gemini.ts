// src/agent/providers/gemini.ts
// ============================================================
// Gemini Provider — Google AI via OpenAI-compatible endpoint
// ============================================================

import { config } from "../../config.ts";
import { BaseChatProvider } from "./base-chat.ts";

export class GeminiProvider extends BaseChatProvider {
  readonly name = "gemini";

  protected getBaseUrl(): string {
    return (
      config.agentBaseUrl ||
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = config.agentApiKey;
    if (!apiKey) {
      throw new Error("AGENT_API_KEY is required for Gemini provider");
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  protected getDefaultModel(): string {
    return config.agentModel || "gemini-2.5-pro";
  }
}
