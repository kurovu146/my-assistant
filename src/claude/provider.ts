// src/claude/provider.ts
// ============================================================
// Claude Provider — Wraps Claude Agent SDK
// ============================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { buildSystemPrompt, setOnCacheClear } from "./skills.ts";
import { createGmailMcpServer } from "../mcp/gmail.ts";
import { logger } from "../logger.ts";
import { createSheetsMcpServer } from "../mcp/sheets.ts";
import { createMemoryMcpServer } from "../mcp/memory.ts";
import { createKnowledgeMcpServer } from "../mcp/knowledge.ts";
import { buildMemoryContext } from "../memory/extraction.ts";
import { clearActiveSession } from "../db/sessions.ts";
import type {
  AgentProvider,
  CompletionProvider,
  AgentQueryOptions,
  AgentResponse,
  CompletionOptions,
  CumulativeUsage,
  UsageStats,
} from "./types.ts";

// --- Tools ---
// Lưu ý: `allowedTools` của SDK là danh sách auto-approve, KHÔNG giới hạn tool.
// Muốn giới hạn thật thì phải dùng `tools` (base set) + `disallowedTools`.

const READONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
const WRITE_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit"];

/** Log mọi lệnh shell agent chạy — dấu vết điều tra khi prompt injection lọt qua */
const auditBashHook = {
  PreToolUse: [
    {
      hooks: [
        async (input: unknown) => {
          const { tool_name, tool_input } = input as {
            tool_name?: string;
            tool_input?: { command?: string };
          };
          if (tool_name === "Bash" && tool_input?.command) {
            logger.log(`🔒 Bash: ${tool_input.command.slice(0, 300)}`);
          }
          return { continue: true };
        },
      ],
    },
  ],
};

// --- Retry with backoff + model failover ---

// Export cho test: R-4 cần dựng đúng kịch bản "lỗi xảy ra ở lượt thử cuối" mà
// không hardcode trùng lặp con số này ở hai nơi.
export const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30_000;

const FAILOVER_CHAIN: Record<string, string> = {
  "claude-opus-5": "claude-sonnet-5",
  "claude-sonnet-5": "claude-haiku-4-5",
};

function getFailoverModel(currentModel: string): string | null {
  return FAILOVER_CHAIN[currentModel] || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phiên cũ không nối lại được — SDK không tìm thấy transcript của session id đó.
 *
 * Transcript nằm ở `~/.claude/projects/<cwd-đã-escape>/<session-id>.jsonl`, nên lỗi
 * này xảy ra khi cwd lúc resume khác cwd lúc tạo phiên, hoặc file transcript bị xoá.
 * Không phải lỗi tạm thời: retry y nguyên bao nhiêu lần cũng ra đúng lỗi đó.
 */
function isSessionNotFoundError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.toLowerCase().includes("no conversation found");
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
  private sheetsMcp: ReturnType<typeof createSheetsMcpServer>;
  private cumulativeUsage: CumulativeUsage = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    queryCount: 0,
  };

  constructor() {
    this.gmailMcp = createGmailMcpServer();
    this.sheetsMcp = createSheetsMcpServer();
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
    logger.log("🔄 Skills cache cleared — sẽ reload lần gọi tiếp theo");
  }

  // --- Usage ---

  getCumulativeUsage(): CumulativeUsage {
    return { ...this.cumulativeUsage };
  }

  // --- Main query ---

  async query(options: AgentQueryOptions): Promise<AgentResponse> {
    const { prompt, sessionId, onProgress, abortSignal, userId, modelOverride, cwd, project } = options;
    const toolsUsed: string[] = [];
    const textParts: string[] = [];
    let resolvedSessionId = sessionId || "";
    let activeModel = modelOverride;
    // Tách khỏi `sessionId`: khi phiên cũ không nối lại được, ta bỏ resume và chạy
    // lại như phiên mới thay vì để lỗi nổi lên user (xem nhánh catch bên dưới).
    let resumeSessionId = sessionId || "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const systemPrompt = await this.getSystemPrompt();

        // Inject memory context (Tier 1: passive recall)
        let enrichedPrompt = prompt;
        if (userId) {
          const memoryContext = buildMemoryContext(userId, project);
          if (memoryContext) {
            enrichedPrompt = prompt + memoryContext;
          }
        }

        // Memory MCP server (Tier 2: active tools) + knowledge base / entity graph.
        // Bind luôn project của query này — tool không được tự tra lại project hiện
        // tại, xem createMemoryMcpServer.
        const memoryMcp = userId ? createMemoryMcpServer(userId, project ?? "") : null;
        const knowledgeMcp = userId ? createKnowledgeMcpServer(userId) : null;

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
            cwd: cwd || config.claudeWorkingDir,
            mcpServers: {
              ...(this.gmailMcp ? { gmail: this.gmailMcp } : {}),
              ...(this.sheetsMcp ? { sheets: this.sheetsMcp } : {}),
              ...(memoryMcp ? { memory: memoryMcp } : {}),
              ...(knowledgeMcp ? { knowledge: knowledgeMcp } : {}),
            },
            allowedTools: [
              ...READONLY_TOOLS,
              ...WRITE_TOOLS,
              ...(this.gmailMcp ? ["mcp__gmail__*"] : []),
              ...(this.sheetsMcp ? ["mcp__sheets__*"] : []),
              ...(memoryMcp ? ["mcp__memory__*"] : []),
              ...(knowledgeMcp ? ["mcp__knowledge__*"] : []),
            ],
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
            hooks: auditBashHook,
            // Không giới hạn số turn lẫn thời gian: task chạy tới khi xong.
            // Phanh duy nhất là /stop của user (abortSignal bên dưới).
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            ...(abortSignal
              ? {
                  abortController: (() => {
                    const controller = new AbortController();
                    abortSignal.addEventListener("abort", () => controller.abort(abortSignal.reason), {
                      once: true,
                    });
                    return controller;
                  })(),
                }
              : {}),
          },
        });

        let usage: UsageStats | undefined;

        for await (const message of stream) {
          resolvedSessionId = extractSessionId(message, resolvedSessionId);

          switch (message.type) {
            case "assistant": {
              // Model có thể suy nghĩ hàng chục giây trước khi ra chữ đầu (đo được:
              // thinking ở giây 41, text ở giây 86). Không báo gì trong khoảng đó thì
              // Telegram đứng nguyên "Đang xử lý..." và anh Tuấn tưởng bot treo.
              if (hasThinking(message)) {
                onProgress?.({ type: "thinking", content: "" });
              }

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
                logger.error("❌ Claude result error:", message.error);
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
        // Query chỉ dừng giữa chừng khi user gõ /stop — không còn timeout nào
        if (abortSignal?.aborted) {
          const partial = textParts.join("").trim();
          return {
            text: partial || "⏹ Query đã bị dừng.",
            sessionId: resolvedSessionId,
            toolsUsed: [...new Set(toolsUsed)],
          };
        }

        // Lưới an toàn: phiên cũ không nối lại được thì bỏ nó. Không có nhánh này,
        // lỗi nổi thẳng lên user MÀ session id đã chết vẫn nằm nguyên trong
        // active_sessions (lỗi ném ra trước nhánh tạo phiên mới) — nên mọi tin nhắn
        // sau đều lỗi y hệt, mãi mãi, không có đường tự thoát.
        //
        // Dọn active_sessions phải chạy VÔ ĐIỀU KIỆN khi nhận diện được lỗi này —
        // kể cả khi đây đã là lượt thử cuối (attempt === MAX_RETRIES). Trước đây
        // điều kiện `attempt < MAX_RETRIES` bọc luôn cả phần dọn, nên đúng lượt
        // cuối thì lỗi rơi xuống nhánh trả lỗi chung MÀ session chết vẫn còn trong
        // DB — kẹt lại y hệt bug mà nhánh này sinh ra để sửa. Chỉ có `continue`
        // (chạy lại như phiên mới) mới cần gác theo số lần thử còn lại.
        if (isSessionNotFoundError(error) && resumeSessionId) {
          logger.log(`⚠️ Không nối lại được phiên ${resumeSessionId} — bỏ phiên chết`);
          if (userId !== undefined) clearActiveSession(userId, project ?? "");
          resumeSessionId = "";
          toolsUsed.length = 0;
          textParts.length = 0;
          resolvedSessionId = "";

          if (attempt < MAX_RETRIES) {
            onProgress?.({
              type: "text_chunk",
              content: "\n⚠️ Phiên cũ không nối lại được, đã mở phiên mới.\n",
            });
            continue;
          }
          // Hết lượt thử — rơi xuống nhánh trả lỗi chung bên dưới, nhưng DB đã sạch.
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
              logger.log(`🔄 Failover: ${currentModel} → ${fallback}`);
              onProgress?.({ type: "text_chunk", content: `\n🔄 Chuyển sang model backup...\n` });
            }
          }

          logger.log(`⚡ Retry ${attempt + 1}/${MAX_RETRIES} sau ${Math.round(delay)}ms...`);
          onProgress?.({ type: "text_chunk", content: `\n⚡ Đang retry (${attempt + 1}/${MAX_RETRIES})...\n` });
          await sleep(delay);
          toolsUsed.length = 0;
          textParts.length = 0;
          continue;
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error("❌ Claude Agent error:", errMsg);
        if (stack) logger.error("Stack:", stack);

        let hint = "";
        if (errMsg.includes("auth") || errMsg.includes("credential") || errMsg.includes("login")) {
          hint = "\n\n💡 Thử: chạy `claude` trên terminal và login lại.";
        }
        if (errMsg.includes("API key")) {
          hint = "\n\n💡 Đảm bảo KHÔNG set ANTHROPIC_API_KEY trong .env khi dùng subscription.";
        }
        if (errMsg.includes("exited with code")) {
          hint = "\n\n💡 Claude CLI process crashed. Kiểm tra: claude auth status";
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
        model: model || "claude-haiku-4-5",
        ...(systemPrompt ? { systemPrompt } : {}),
        maxTurns: maxTurns ?? 1,
        // `allowedTools: []` từng được dùng ở đây nhưng KHÔNG hạn chế gì — nó chỉ là
        // danh sách auto-approve. Model vẫn có đủ 29 tool (Bash, Write, Task...) và khi
        // nó chọn gọi tool ở lượt đầu thì maxTurns=1 chạm trần ngay, extraction hỏng.
        // `tools: []` mới thực sự tắt built-in; strictMcpConfig chặn nốt MCP của máy.
        tools: [],
        strictMcpConfig: true,
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

function hasThinking(message: SDKMessage): boolean {
  if (message.type !== "assistant" || !message.message?.content) return false;
  return message.message.content.some((block: any) => block.type === "thinking");
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

// --- Singleton ---

let _instance: ClaudeProvider | null = null;

export function getClaudeProvider(): ClaudeProvider {
  if (!_instance) {
    _instance = new ClaudeProvider();
    logger.log(`🔌 Claude provider initialized`);
  }
  return _instance;
}
