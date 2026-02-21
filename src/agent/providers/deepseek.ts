// src/agent/providers/deepseek.ts
// ============================================================
// DeepSeek Provider — OpenAI-compatible API
// ============================================================

import { config } from "../../config.ts";
import { BaseChatProvider } from "./base-chat.ts";

export class DeepSeekProvider extends BaseChatProvider {
  readonly name = "deepseek";

  protected getBaseUrl(): string {
    return config.agentBaseUrl || "https://api.deepseek.com/chat/completions";
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = config.agentApiKey;
    if (!apiKey) {
      throw new Error("AGENT_API_KEY is required for DeepSeek provider");
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  protected getDefaultModel(): string {
    return config.agentModel || "deepseek-chat";
  }
}
