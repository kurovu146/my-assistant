// src/agent/providers/base-chat.ts
// ============================================================
// BaseChatProvider — Base class cho OpenAI-compatible providers
// ============================================================
// Dùng raw fetch() tới OpenAI-compatible /chat/completions endpoint
// Không thêm dependency mới — chỉ cần built-in fetch
//
// Features:
// - In-memory conversation history (Map<sessionId, Message[]>)
// - SSE streaming parser
// - Retry + backoff
// - Session management
// ============================================================

import { config } from "../../config.ts";
import { buildSystemPrompt, setOnCacheClear } from "../skills.ts";
import { buildMemoryContext } from "../../services/memory.ts";
import type {
  AgentProvider,
  CompletionProvider,
  AgentQueryOptions,
  AgentResponse,
  CompletionOptions,
  CumulativeUsage,
  UsageStats,
} from "../types.ts";

// --- Types ---

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface SessionHistory {
  messages: ChatMessage[];
  lastActive: number;
}

// --- Base class ---

export abstract class BaseChatProvider implements AgentProvider, CompletionProvider {
  abstract readonly name: string;

  /** API endpoint URL */
  protected abstract getBaseUrl(): string;

  /** Headers (Authorization, etc.) */
  protected abstract getHeaders(): Record<string, string>;

  /** Default model khi không specify */
  protected abstract getDefaultModel(): string;

  // In-memory conversation history
  private sessions = new Map<string, SessionHistory>();
  private sessionCounter = 0;

  private cachedSystemPrompt: string | null = null;
  private cumulativeUsage: CumulativeUsage = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    queryCount: 0,
  };

  constructor() {
    setOnCacheClear(() => {
      this.cachedSystemPrompt = null;
    });

    // Cleanup old sessions mỗi giờ
    setInterval(() => this.cleanupSessions(), 60 * 60 * 1000);
  }

  // --- Auth ---

  async checkAuth(): Promise<{ ok: boolean; message: string }> {
    try {
      // Test API call đơn giản
      const response = await fetch(this.getBaseUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getHeaders(),
        },
        body: JSON.stringify({
          model: this.getDefaultModel(),
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        return { ok: true, message: `✅ ${this.name} API connected` };
      }

      const errorText = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `❌ ${this.name} auth failed: invalid API key` };
      }
      return { ok: false, message: `❌ ${this.name} API error (${response.status}): ${errorText.slice(0, 100)}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `❌ ${this.name} connection failed: ${msg}` };
    }
  }

  // --- System prompt ---

  private async getSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt === null) {
      this.cachedSystemPrompt = await buildSystemPrompt();
    }
    return this.cachedSystemPrompt;
  }

  // --- Skills ---

  reloadSkills(): void {
    this.cachedSystemPrompt = null;
    console.log("🔄 Skills cache cleared — sẽ reload lần gọi tiếp theo");
  }

  // --- Usage ---

  getCumulativeUsage(): CumulativeUsage {
    return { ...this.cumulativeUsage };
  }

  // --- Session management ---

  private getOrCreateSession(sessionId?: string): { id: string; history: SessionHistory } {
    if (sessionId && this.sessions.has(sessionId)) {
      const history = this.sessions.get(sessionId)!;
      history.lastActive = Date.now();
      return { id: sessionId, history };
    }

    const id = sessionId || `session-${Date.now()}-${++this.sessionCounter}`;
    const history: SessionHistory = { messages: [], lastActive: Date.now() };
    this.sessions.set(id, history);
    return { id, history };
  }

  private cleanupSessions(): void {
    const maxAge = config.sessionTimeoutHours * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > maxAge) {
        this.sessions.delete(id);
      }
    }
  }

  // --- Main query ---

  async query(options: AgentQueryOptions): Promise<AgentResponse> {
    const { prompt, sessionId, onProgress, abortSignal, userId, modelOverride } = options;

    const model = modelOverride || config.agentModel || this.getDefaultModel();
    const { id: resolvedSessionId, history } = this.getOrCreateSession(sessionId);

    try {
      const systemPrompt = await this.getSystemPrompt();

      // Inject memory context
      let enrichedPrompt = prompt;
      if (userId) {
        const memoryContext = buildMemoryContext(userId);
        if (memoryContext) {
          enrichedPrompt = prompt + memoryContext;
        }
      }

      // Build messages array
      const messages: ChatMessage[] = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }

      // Add conversation history
      messages.push(...history.messages);

      // Add current user message
      messages.push({ role: "user", content: enrichedPrompt });

      // API call with streaming
      const startTime = Date.now();
      const { text, usage } = await this.fetchStreamingCompletion(
        model,
        messages,
        onProgress,
        abortSignal,
      );

      // Update cumulative usage
      if (usage) {
        this.cumulativeUsage.totalInputTokens += usage.inputTokens;
        this.cumulativeUsage.totalOutputTokens += usage.outputTokens;
        this.cumulativeUsage.totalCostUSD += usage.costUSD;
      }
      this.cumulativeUsage.queryCount++;

      // Save to history
      history.messages.push(
        { role: "user", content: enrichedPrompt },
        { role: "assistant", content: text },
      );

      // Trim history nếu quá dài (giữ 20 messages gần nhất)
      if (history.messages.length > 40) {
        history.messages = history.messages.slice(-20);
      }

      return {
        text: text || `(${this.name} không trả lời text)`,
        sessionId: resolvedSessionId,
        toolsUsed: [],
        usage,
        model,
      };
    } catch (error) {
      // Handle abort
      const isAborted = abortSignal?.aborted;
      if (isAborted) {
        return {
          text: "⏹ Query đã bị dừng.",
          sessionId: resolvedSessionId,
          toolsUsed: [],
        };
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${this.name} error:`, errMsg);
      return {
        text: "",
        sessionId: resolvedSessionId,
        toolsUsed: [],
        error: errMsg,
      };
    }
  }

  // --- Streaming fetch ---

  private async fetchStreamingCompletion(
    model: string,
    messages: ChatMessage[],
    onProgress?: AgentQueryOptions["onProgress"],
    abortSignal?: AbortSignal,
  ): Promise<{ text: string; usage?: UsageStats }> {
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(2 * 60 * 60 * 1000);
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutSignal, controller.signal])
      : AbortSignal.any([timeoutSignal, controller.signal]);

    const response = await fetch(this.getBaseUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.getHeaders(),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 8192,
      }),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${this.name} API error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    // Parse SSE stream
    const text = await this.parseSSEStream(response, onProgress);

    return { text };
  }

  // --- SSE parser ---

  private async parseSSEStream(
    response: Response,
    onProgress?: AgentQueryOptions["onProgress"],
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              fullText += delta.content;
              onProgress?.({ type: "text_chunk", content: delta.content });
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullText.trim();
  }

  // --- CompletionProvider ---

  async complete(options: CompletionOptions): Promise<string> {
    const { prompt, systemPrompt, model } = options;
    const resolvedModel = model || this.getDefaultModel();

    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await fetch(this.getBaseUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.getHeaders(),
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`${this.name} completion error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    return (data.choices?.[0]?.message?.content || "").trim();
  }
}
