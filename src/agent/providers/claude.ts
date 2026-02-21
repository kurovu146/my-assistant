// src/agent/providers/claude.ts
// ============================================================
// Claude Provider — Wraps Claude Agent SDK into AgentProvider
// ============================================================
// Logic moved from src/agent/claude.ts (original wrapper)

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../config.ts";
import { buildSystemPrompt, setOnCacheClear } from "../skills.ts";
import { createGmailMcpServer } from "../../services/gmail.ts";
import { createMemoryMcpServer } from "../../services/memory-mcp.ts";
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

// --- Retry with backoff + model failover ---

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30_000;

const FAILOVER_CHAIN: Record<string, string> = {
  "claude-opus-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-haiku-4-5-20251001",
};

function getFailoverModel(currentModel: string): string | null {
  return FAILOVER_CHAIN[currentModel] || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("overloaded")) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("529")) return true;
    if (msg.includes("internal server error") || msg.includes("service unavailable")) return true;
  }
  return false;
}

// --- Claude Provider Class ---

export class ClaudeProvider implements AgentProvider, CompletionProvider {
  readonly name = "claude";

  private cachedSystemPrompt: string | null = null;
  private gmailMcp: ReturnType<typeof createGmailMcpServer>;
  private cumulativeUsage: CumulativeUsage = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    queryCount: 0,
  };

  constructor() {
    this.gmailMcp = createGmailMcpServer();
    setOnCacheClear(() => {
      this.cachedSystemPrompt = null;
    });
  }

  // --- Auth ---

  async checkAuth(): Promise<{ ok: boolean; message: string }> {
    if (config.authMode === "api-key") {
      return { ok: true, message: "Dùng API Key auth" };
    }

    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const proc = Bun.spawn(["claude", "auth", "status"], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return {
          ok: false,
          message: "❌ Chưa login Claude Code. Chạy: claude → login bằng Google.",
        };
      }

      const status = JSON.parse(output.trim());
      if (status.loggedIn && status.authMethod === "claude.ai") {
        const plan = status.subscriptionType || "unknown";
        const email = status.email || "";
        return {
          ok: true,
          message: `✅ Subscription auth (${plan} plan) — ${email}`,
        };
      }

      return {
        ok: false,
        message: "❌ Claude Code chưa login. Chạy: claude → login bằng Google.",
      };
    } catch {
      return {
        ok: false,
        message: "❌ Không tìm thấy Claude CLI. Cài đặt: curl -fsSL https://claude.ai/install.sh | bash",
      };
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

  // --- Main query ---

  async query(options: AgentQueryOptions): Promise<AgentResponse> {
    const { prompt, sessionId, onProgress, abortSignal, userId, modelOverride } = options;
    const toolsUsed: string[] = [];
    const textParts: string[] = [];
    let resolvedSessionId = sessionId || "";
    let activeModel = modelOverride;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const systemPrompt = await this.getSystemPrompt();

        // Inject memory context (Tier 1: passive recall)
        let enrichedPrompt = prompt;
        if (userId) {
          const memoryContext = buildMemoryContext(userId);
          if (memoryContext) {
            enrichedPrompt = prompt + memoryContext;
          }
        }

        // Memory MCP server (Tier 2: active tools)
        const memoryMcp = userId ? createMemoryMcpServer(userId) : null;

        const stream = query({
          prompt: enrichedPrompt,
          options: {
            model: activeModel || config.claudeModel,
            ...(systemPrompt
              ? {
                  systemPrompt: {
                    type: "preset" as const,
                    preset: "claude_code" as const,
                    append: systemPrompt,
                  },
                }
              : {}),
            cwd: config.claudeWorkingDir,
            ...(config.cliPath ? { pathToClaudeCodeExecutable: config.cliPath } : {}),
            mcpServers: {
              ...(this.gmailMcp ? { gmail: this.gmailMcp } : {}),
              ...(memoryMcp ? { memory: memoryMcp } : {}),
            },
            allowedTools: [
              "Bash",
              "Read",
              "Write",
              "Glob",
              "Grep",
              "WebSearch",
              "WebFetch",
              ...(this.gmailMcp ? ["mcp__gmail__*"] : []),
              ...(memoryMcp ? ["mcp__memory__*"] : []),
            ],
            permissionMode: "bypassPermissions",
            maxTurns: (activeModel || config.claudeModel).includes("haiku") ? 5 : config.maxTurns,
            ...(sessionId ? { resume: sessionId } : {}),
            abortController: (() => {
              const controller = new AbortController();
              const timeoutSignal = AbortSignal.timeout(2 * 60 * 60 * 1000);
              const combinedSignal = abortSignal
                ? AbortSignal.any([abortSignal, timeoutSignal])
                : timeoutSignal;
              combinedSignal.addEventListener("abort", () => controller.abort(combinedSignal.reason), { once: true });
              return controller;
            })(),
          },
        });

        let usage: UsageStats | undefined;

        for await (const message of stream) {
          resolvedSessionId = extractSessionId(message, resolvedSessionId);

          switch (message.type) {
            case "assistant": {
              const text = extractText(message);
              if (text) {
                textParts.push(text);
                onProgress?.({ type: "text_chunk", content: text });
              }
              const tools = extractToolUse(message);
              toolsUsed.push(...tools);
              for (const tool of tools) {
                onProgress?.({ type: "tool_use", content: tool });
              }
              break;
            }
            case "result": {
              if ("result" in message && message.result && textParts.length === 0) {
                textParts.push(message.result);
              }
              if ("error" in message && message.error) {
                console.error("❌ Claude result error:", message.error);
              }
              usage = extractUsage(message);
              if (usage) {
                this.cumulativeUsage.totalInputTokens += usage.inputTokens;
                this.cumulativeUsage.totalOutputTokens += usage.outputTokens;
                this.cumulativeUsage.totalCostUSD += usage.costUSD;
                this.cumulativeUsage.queryCount++;
              }
              break;
            }
          }
        }

        const fullText = textParts.join("").trim();
        return {
          text: fullText || "(Claude không trả lời text)",
          sessionId: resolvedSessionId,
          toolsUsed: [...new Set(toolsUsed)],
          usage,
          model: activeModel || config.claudeModel,
        };
      } catch (error) {
        // Handle abort gracefully
        const isAborted = abortSignal?.aborted;
        const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
        if (isAborted || isTimeout) {
          const partial = textParts.join("").trim();
          const reason = isTimeout
            ? "⏱ Query bị timeout (quá 2 giờ)."
            : "⏹ Query đã bị dừng.";
          return {
            text: partial || reason,
            sessionId: resolvedSessionId,
            toolsUsed: [...new Set(toolsUsed)],
            ...(isTimeout ? { error: reason } : {}),
          };
        }

        // Retry with backoff + model failover
        if (isRetryableError(error) && attempt < MAX_RETRIES) {
          const jitter = BASE_DELAY_MS * Math.pow(2, attempt) * (0.7 + Math.random() * 0.6);
          const delay = Math.min(jitter, MAX_DELAY_MS);

          if (attempt >= 1) {
            const currentModel = activeModel || config.claudeModel;
            const fallback = getFailoverModel(currentModel);
            if (fallback) {
              activeModel = fallback;
              console.log(`🔄 Failover: ${currentModel} → ${fallback}`);
              onProgress?.({ type: "text_chunk", content: `\n🔄 Chuyển sang model backup...\n` });
            }
          }

          console.log(`⚡ Retry ${attempt + 1}/${MAX_RETRIES} sau ${Math.round(delay)}ms...`);
          onProgress?.({ type: "text_chunk", content: `\n⚡ Đang retry (${attempt + 1}/${MAX_RETRIES})...\n` });
          await sleep(delay);
          toolsUsed.length = 0;
          textParts.length = 0;
          continue;
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("❌ Claude Agent error:", errMsg);

        let hint = "";
        if (errMsg.includes("auth") || errMsg.includes("credential") || errMsg.includes("login")) {
          hint = "\n\n💡 Thử: chạy `claude` trên terminal và login lại.";
        }
        if (errMsg.includes("API key")) {
          hint = "\n\n💡 Đảm bảo KHÔNG set ANTHROPIC_API_KEY trong .env khi dùng subscription.";
        }

        return {
          text: "",
          sessionId: resolvedSessionId,
          toolsUsed,
          error: errMsg + hint,
        };
      }
    }

    return {
      text: "",
      sessionId: resolvedSessionId,
      toolsUsed,
      error: "Đã retry hết số lần cho phép",
    };
  }

  // --- CompletionProvider ---

  async complete(options: CompletionOptions): Promise<string> {
    const { prompt, systemPrompt, model, maxTurns } = options;

    const stream = query({
      prompt,
      options: {
        model: model || "claude-haiku-4-5-20251001",
        ...(systemPrompt ? { systemPrompt } : {}),
        maxTurns: maxTurns ?? 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
      },
    });

    let resultText = "";
    for await (const message of stream) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ((block as any).type === "text") {
            resultText += (block as any).text;
          }
        }
      }
      if (message.type === "result" && "result" in message && message.result) {
        if (!resultText) resultText = message.result;
      }
    }

    return resultText.trim();
  }
}

// --- Helper functions (private to this module) ---

function extractText(message: SDKMessage): string {
  if (message.type !== "assistant" || !message.message?.content) return "";
  return message.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
}

function extractToolUse(message: SDKMessage): string[] {
  if (message.type !== "assistant" || !message.message?.content) return [];
  return message.message.content
    .filter((block: any) => block.type === "tool_use")
    .map((block: any) => block.name);
}

function extractSessionId(message: SDKMessage, fallback: string): string {
  if ("session_id" in message && message.session_id) {
    return message.session_id as string;
  }
  return fallback;
}

function extractUsage(message: SDKMessage): UsageStats | undefined {
  if (message.type !== "result") return undefined;

  const msg = message as any;

  if (msg.modelUsage) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUSD = 0;

    for (const model of Object.values(msg.modelUsage) as any[]) {
      inputTokens += model.inputTokens || 0;
      outputTokens += model.outputTokens || 0;
      cacheReadTokens += model.cacheReadInputTokens || 0;
      cacheCreationTokens += model.cacheCreationInputTokens || 0;
      costUSD += model.costUSD || 0;
    }

    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUSD };
  }

  if (msg.usage) {
    const u = msg.usage;
    return {
      inputTokens: u.input_tokens ?? u.inputTokens ?? 0,
      outputTokens: u.output_tokens ?? u.outputTokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0,
      costUSD: msg.total_cost_usd ?? 0,
    };
  }

  return undefined;
}
