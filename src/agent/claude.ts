// src/agent/claude.ts
// ============================================================
// Claude Agent — Wrapper quanh Claude Agent SDK
// ============================================================
//
// AUTH: Subscription Max
// → SDK tự dùng credentials từ ~/.claude/.credentials.json
// → Bạn KHÔNG cần truyền API key
// → Credentials được tạo khi bạn chạy `claude` và login
//
// FLOW:
// askClaude("review file main.go")
//   → SDK tạo agent loop
//   → Claude tự quyết định dùng tools nào (Read, Bash...)
//   → Claude trả kết quả
//   → Hàm trả về { text, sessionId, toolsUsed }
//
// ============================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { buildSystemPrompt } from "./skills.ts";
import { createGmailMcpServer } from "../services/gmail.ts";

// Cache system prompt — load 1 lần khi bot khởi động
let cachedSystemPrompt: string | null = null;

// Gmail MCP server — khởi tạo 1 lần, null nếu thiếu credentials
const gmailMcp = createGmailMcpServer();

/**
 * Lấy system prompt (có cache).
 * Lần đầu gọi sẽ đọc CLAUDE.md + skills/ từ disk.
 * Các lần sau dùng cache.
 */
async function getSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt === null) {
    cachedSystemPrompt = await buildSystemPrompt();
  }
  return cachedSystemPrompt;
}

/**
 * Xóa cache system prompt.
 * Gọi khi muốn reload skills (ví dụ: thêm file .md mới).
 */
export function reloadSkills(): void {
  cachedSystemPrompt = null;
  console.log("🔄 Skills cache cleared — sẽ reload lần gọi tiếp theo");
}

// --- Types ---

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
}

export interface AgentResponse {
  text: string; // Câu trả lời của Claude
  sessionId: string; // ID để resume phiên sau
  toolsUsed: string[]; // Tools Claude đã dùng (Read, Bash, WebSearch...)
  usage?: UsageStats; // Token usage stats
  error?: string; // Lỗi nếu có
}

// --- Cumulative usage tracking ---
// Track tổng token đã dùng từ lúc bot khởi động

export interface CumulativeUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  queryCount: number;
}

const cumulativeUsage: CumulativeUsage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUSD: 0,
  queryCount: 0,
};

export function getCumulativeUsage(): CumulativeUsage {
  return { ...cumulativeUsage };
}

/**
 * Callback khi Claude đang xử lý.
 * Dùng để gửi "đang tìm kiếm..." cho user trên Telegram.
 */
export type OnProgressCallback = (update: {
  type: "thinking" | "tool_use" | "text_chunk";
  content: string;
}) => void;

// --- Kiểm tra auth ---

/**
 * Kiểm tra Claude CLI đã login chưa.
 * Gọi 1 lần lúc bot khởi động.
 *
 * Nếu chưa login → in hướng dẫn rõ ràng → dừng bot.
 * Tốt hơn là để bot chạy rồi crash không rõ lý do.
 */
/**
 * Kiểm tra Claude CLI đã login chưa.
 * Chạy `claude auth status` và đọc kết quả.
 */
export async function checkAuth(): Promise<{ ok: boolean; message: string }> {
  if (config.authMode === "api-key") {
    return { ok: true, message: "Dùng API Key auth" };
  }

  try {
    // Chạy `claude auth status` để kiểm tra
    // Unset CLAUDECODE để tránh "nested session" error
    // khi bot chạy bên trong môi trường Claude Code
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

    // Parse JSON output
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
  } catch (error) {
    return {
      ok: false,
      message:
        "❌ Không tìm thấy Claude CLI. Cài đặt: curl -fsSL https://claude.ai/install.sh | bash",
    };
  }
}

// --- Hàm chính ---

/**
 * Gửi prompt tới Claude và nhận kết quả.
 *
 * Đây là hàm duy nhất các file khác cần gọi.
 * Nó che giấu toàn bộ sự phức tạp của SDK bên trong.
 *
 * @param prompt    - Câu hỏi từ user (text thuần)
 * @param sessionId - Session ID để resume (undefined = phiên mới)
 * @param onProgress - Callback cho progress updates (tùy chọn)
 *
 * @example
 * // Phiên mới
 * const res = await askClaude("Giải thích async/await");
 * console.log(res.text);       // Câu trả lời
 * console.log(res.sessionId);  // Lưu lại để resume
 *
 * // Resume phiên cũ
 * const res2 = await askClaude("Cho ví dụ cụ thể", res.sessionId);
 */
export async function askClaude(
  prompt: string,
  sessionId?: string,
  onProgress?: OnProgressCallback,
  abortSignal?: AbortSignal,
): Promise<AgentResponse> {
  const toolsUsed: string[] = [];
  const textParts: string[] = [];
  let resolvedSessionId = sessionId || "";

  try {
    // Load system prompt (CLAUDE.md + skills/)
    const systemPrompt = await getSystemPrompt();

    // Tạo query — SDK sẽ chạy agent loop tự động
    // Claude sẽ tự quyết định dùng tools nào dựa trên prompt
    const stream = query({
      prompt,
      options: {
        // Model — Max plan dùng được tất cả
        model: config.claudeModel,

        // System prompt — CLAUDE.md + skills/
        ...(systemPrompt
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: systemPrompt,
              },
            }
          : {}),

        // Thư mục làm việc — Claude đọc/ghi file ở đây
        cwd: config.claudeWorkingDir,

        // CLI path (tùy chọn)
        ...(config.cliPath ? { pathToClaudeCodeExecutable: config.cliPath } : {}),

        // MCP servers — Gmail integration (nếu có credentials)
        ...(gmailMcp ? { mcpServers: { gmail: gmailMcp } } : {}),

        // Tools Claude được phép dùng
        // Claude TỰ QUYẾT ĐỊNH dùng tool nào, bạn chỉ cho phép
        allowedTools: [
          "Bash", // Chạy lệnh: go build, npm test, git log...
          "Read", // Đọc file
          "Write", // Ghi/sửa file
          "Glob", // Tìm file: *.go, src/**/*.ts
          "Grep", // Tìm text trong file
          "WebSearch", // Google search
          "WebFetch", // Lấy nội dung URL
          ...(gmailMcp ? ["mcp__gmail__*"] : []), // Gmail tools
        ],

        // Bỏ qua permission prompts
        // Vì chat qua Telegram, không thể hỏi "cho phép không?"
        permissionMode: "bypassPermissions",

        // Giới hạn số vòng agent loop — tránh chạy quá lâu
        maxTurns: config.maxTurns,

        // Resume phiên cũ nếu có sessionId
        ...(sessionId ? { resume: sessionId } : {}),

        // AbortController — cho phép /stop hủy query + auto-timeout 2 giờ
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

    // --- Stream qua từng message ---
    // Claude Agent SDK trả về nhiều message types:
    // - "assistant": Claude đang nói hoặc dùng tool
    // - "result": kết quả cuối cùng
    // Mình lọc ra text và tên tools đã dùng

    let usage: UsageStats | undefined;

    for await (const message of stream) {
      // Lấy session ID từ message đầu tiên
      resolvedSessionId = extractSessionId(message, resolvedSessionId);

      switch (message.type) {
        case "assistant": {
          // Trích xuất text Claude viết
          const text = extractText(message);
          if (text) {
            textParts.push(text);
            onProgress?.({ type: "text_chunk", content: text });
          }

          // Trích xuất tools Claude dùng
          const tools = extractToolUse(message);
          toolsUsed.push(...tools);
          for (const tool of tools) {
            onProgress?.({ type: "tool_use", content: tool });
          }
          break;
        }

        case "result": {
          // Result chứa text tổng hợp cuối cùng.
          // Chỉ dùng nếu CHƯA có text nào từ assistant messages
          // (tránh duplicate vì assistant messages đã stream text rồi)
          if ("result" in message && message.result && textParts.length === 0) {
            textParts.push(message.result);
          }
          if ("error" in message && message.error) {
            console.error("❌ Claude result error:", message.error);
          }

          // Capture token usage từ result message
          usage = extractUsage(message);
          if (usage) {
            cumulativeUsage.totalInputTokens += usage.inputTokens;
            cumulativeUsage.totalOutputTokens += usage.outputTokens;
            cumulativeUsage.totalCostUSD += usage.costUSD;
            cumulativeUsage.queryCount++;
          }
          break;
        }
      }
    }

    const fullText = textParts.join("").trim();

    return {
      text: fullText || "(Claude không trả lời text)",
      sessionId: resolvedSessionId,
      toolsUsed: [...new Set(toolsUsed)], // Loại bỏ trùng
      usage,
    };
  } catch (error) {
    // Handle abort gracefully — phân biệt timeout vs user abort
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

    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("❌ Claude Agent error:", errMsg);

    // Gợi ý fix cho lỗi thường gặp
    let hint = "";
    if (
      errMsg.includes("auth") ||
      errMsg.includes("credential") ||
      errMsg.includes("login")
    ) {
      hint = "\n\n💡 Thử: chạy `claude` trên terminal và login lại.";
    }
    if (errMsg.includes("API key")) {
      hint =
        "\n\n💡 Đảm bảo KHÔNG set ANTHROPIC_API_KEY trong .env khi dùng subscription.";
    }

    return {
      text: "",
      sessionId: resolvedSessionId,
      toolsUsed,
      error: errMsg + hint,
    };
  }
}

// --- Helper functions ---
// Các hàm nhỏ để trích xuất data từ SDK message.
// SDK trả về cấu trúc phức tạp, mình lọc lấy phần cần thiết.

/**
 * Lấy text từ assistant message.
 * Message có thể chứa nhiều "content blocks", mình chỉ lấy type "text".
 */
function extractText(message: SDKMessage): string {
  if (message.type !== "assistant" || !message.message?.content) return "";
  return message.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
}

/**
 * Lấy tên tools Claude đã dùng.
 * Ví dụ: ["Read", "Bash", "WebSearch"]
 */
function extractToolUse(message: SDKMessage): string[] {
  if (message.type !== "assistant" || !message.message?.content) return [];
  return message.message.content
    .filter((block: any) => block.type === "tool_use")
    .map((block: any) => block.name);
}

/**
 * Lấy session ID từ message.
 * SDK gửi session_id trong message đầu tiên.
 */
function extractSessionId(message: SDKMessage, fallback: string): string {
  if ("session_id" in message && message.session_id) {
    return message.session_id as string;
  }
  return fallback;
}

/**
 * Lấy token usage từ result message.
 * SDK trả về usage trong cả SDKResultSuccess và SDKResultError.
 * modelUsage (camelCase) chứa breakdown chi tiết theo model.
 */
function extractUsage(message: SDKMessage): UsageStats | undefined {
  if (message.type !== "result") return undefined;

  const msg = message as any;

  // Ưu tiên modelUsage — có đầy đủ thông tin nhất (camelCase keys)
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

  // Fallback: usage field (BetaUsage — snake_case keys)
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
