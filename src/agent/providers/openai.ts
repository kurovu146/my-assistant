// src/agent/providers/openai.ts
// ============================================================
// OpenAI Provider — GPT models via OpenAI API
// ============================================================

import { config } from "../../config.ts";
import { BaseChatProvider } from "./base-chat.ts";

export class OpenAIProvider extends BaseChatProvider {
  readonly name = "openai";

  protected getBaseUrl(): string {
    return config.agentBaseUrl || "https://api.openai.com/v1/chat/completions";
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = config.agentApiKey;
    if (!apiKey) {
      throw new Error("AGENT_API_KEY is required for OpenAI provider");
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  protected getDefaultModel(): string {
    return config.agentModel || "gpt-4o";
  }
}
