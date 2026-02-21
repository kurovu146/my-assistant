// src/bot/telegram.ts
// ============================================================
// Telegram Bot — Xử lý tin nhắn và kết nối với Claude
// ============================================================
//
// Optimizations:
// - Streaming: edit progress message với text đã nhận mỗi 3s
// - Queue: per-user lock, tin sau chờ tin trước xong
// - Abort: truyền AbortSignal vào SDK, /stop hoạt động thật
// - File handlers: dùng session + progress như text handler
// ============================================================

import { Bot } from "grammy";
import { config } from "../config.ts";
import { askClaude } from "../agent/claude.ts";
import { parseModelOverride } from "../agent/router.ts";
import {
  getActiveSession,
  createSession,
  touchSession,
  logQuery,
} from "../storage/db.ts";
import { splitMessage, formatToolsUsed, TOOL_ICONS } from "./formatter.ts";
import { sanitizeResponse } from "./content-filter.ts";
import { extractFacts } from "../services/memory.ts";
import { authMiddleware, rateLimitMiddleware } from "./middleware.ts";
import {
  handleStart,
  handleNew,
  handleResume,
  handleResumeCallback,
  handleStatus,
  handleStop,
  handleReload,
  handleMonitor,
  handleUnmonitor,
  handleMonitors,
  handleMemory,
  activeQueries,
} from "./commands.ts";

// ============================================================
// Sanitize filename — prevent path traversal attacks
// ============================================================

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
}

// ============================================================
// Lane Queue — per-user serial queue (inspired by OpenClaw)
// ============================================================
// Key: userId (single channel = Telegram)
// Queue depth limit: 3 — tránh backlog quá dài
// ============================================================

const userLocks = new Map<number, Promise<void>>();
const userQueueDepth = new Map<number, number>();
const MAX_QUEUE_DEPTH = 3;

/**
 * Queue handler per user (lane queue pattern).
 * Tin nhắn xếp hàng, chạy tuần tự. Max 3 tin trong queue.
 */
function withUserLock(userId: number, fn: () => Promise<void>, onOverflow?: () => Promise<void>): Promise<void> {
  const depth = userQueueDepth.get(userId) || 0;

  // Queue overflow — quá 3 tin đang chờ
  if (depth >= MAX_QUEUE_DEPTH) {
    onOverflow?.();
    return Promise.resolve();
  }

  userQueueDepth.set(userId, depth + 1);

  const prev = userLocks.get(userId) || Promise.resolve();
  const current = prev.then(fn, fn);
  userLocks.set(userId, current);

  current.finally(() => {
    const d = userQueueDepth.get(userId) || 1;
    if (d <= 1) {
      userQueueDepth.delete(userId);
    } else {
      userQueueDepth.set(userId, d - 1);
    }
    if (userLocks.get(userId) === current) {
      userLocks.delete(userId);
    }
  });
  return current;
}

// ============================================================
// Tạo Bot
// ============================================================

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  bot.use(authMiddleware);
  bot.use(rateLimitMiddleware());

  bot.command("start", handleStart);
  bot.command("new", handleNew);
  bot.command("resume", handleResume);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("reload", handleReload);
  bot.command("monitor", handleMonitor);
  bot.command("unmonitor", handleUnmonitor);
  bot.command("monitors", handleMonitors);
  bot.command("memory", handleMemory);

  bot.callbackQuery(/^resume:/, handleResumeCallback);

  bot.on("message:text", handleTextMessage);
  bot.on("message:document", handleDocument);
  bot.on("message:photo", handlePhoto);

  bot.catch((err) => {
    const msg = err.message || String(err);
    // 409 = polling conflict → sẽ được xử lý bởi startPollingWithRecovery
    if (msg.includes("409")) {
      console.error("⚠️ Polling conflict (409):", msg);
    } else {
      console.error("❌ Bot error:", msg);
    }
  });

  return bot;
}

// ============================================================
// Safe message edit — handle Telegram API errors gracefully
// ============================================================

async function safeEditText(
  api: any,
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: string,
): Promise<boolean> {
  try {
    await api.editMessageText(chatId, messageId, text, parseMode ? { parse_mode: parseMode } : undefined);
    return true;
  } catch {
    if (parseMode) {
      // Markdown lỗi → thử plain text
      try {
        await api.editMessageText(chatId, messageId, text);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function safeSendMessage(ctx: any, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text);
  }
}

// ============================================================
// handleQueryWithStreaming — Common streaming logic cho tất cả handlers
// ============================================================
//
// Chứa toàn bộ logic chung:
// - AbortController + activeQueries
// - Typing indicator liên tục
// - Streaming state + flushStream (throttled 1.5s)
// - askClaude call với progress callback
// - Session create/touch
// - Footer (tools + timing)
// - Split + edit/send final messages
// - Error handling + cleanup
// ============================================================

interface StreamingOptions {
  /** Prompt gửi cho Claude */
  prompt: string;
  /** User ID (Telegram) */
  userId: number;
  /** Context object (grammy) */
  ctx: any;
  /** Chat ID */
  chatId: number;
  /** Message ID của progress message (sẽ được edit liên tục) */
  messageId: number;
  /** Title cho session mới (nếu chưa có session) */
  sessionTitle: string;
  /** Label cho error message, vd: "Lỗi", "Lỗi xử lý file" */
  errorLabel: string;
  /** Callback chạy sau khi hoàn thành (cleanup file, etc.) */
  onComplete?: () => Promise<void>;
  /** Model override từ user (Smart Routing) */
  modelOverride?: string;
}

async function handleQueryWithStreaming(options: StreamingOptions): Promise<void> {
  const { prompt, userId, ctx, chatId, messageId, sessionTitle, errorLabel, onComplete, modelOverride } = options;
  const startTime = Date.now();

  // AbortController — /stop sẽ abort signal này
  const controller = new AbortController();
  activeQueries.set(userId, controller);

  // Typing indicator liên tục
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction("typing");
    } catch {}
  }, 4000);

  // Streaming state
  let streamedText = "";
  let lastEditTime = 0;
  let editPending = false;
  let currentTool = ""; // tool đang chạy (hiển thị trong progress)

  // Flush streaming text vào progress message (throttled)
  const flushStream = async (force = false) => {
    const now = Date.now();
    // Throttle: 1.5s giữa mỗi lần edit (Telegram cho ~30 msg/s per chat)
    if (!force && now - lastEditTime < 1500) return;
    if (editPending) return;

    editPending = true;
    lastEditTime = now;

    const preview = streamedText.trim();

    // Build status suffix
    let suffix: string;
    if (currentTool) {
      const icon = TOOL_ICONS[currentTool] || "🔧";
      suffix = `\n\n⏳ ${icon} _Đang dùng ${currentTool}..._`;
    } else {
      suffix = "\n\n⏳ _Đang xử lý..._";
    }

    const displayText = preview
      ? (preview.length > 3800
          ? preview.slice(0, 3800) + "\n\n⏳ _Đang tiếp tục..._"
          : preview + suffix)
      : `⏳${currentTool ? ` ${TOOL_ICONS[currentTool] || "🔧"} Đang dùng ${currentTool}...` : " Đang xử lý..."}`;

    await safeEditText(ctx.api, chatId, messageId, displayText, "Markdown");
    editPending = false;
  };

  try {
    const session = getActiveSession(userId);
    const sessionId = session?.sessionId;

    const selectedModel: string | undefined = modelOverride;

    const response = await askClaude(
      prompt,
      sessionId,
      async (update) => {
        if (update.type === "text_chunk") {
          streamedText += update.content;
          currentTool = ""; // text mới → clear tool indicator
          flushStream().catch(() => {});
        } else if (update.type === "tool_use") {
          currentTool = update.content;
          // Luôn flush khi có tool mới (dù đã có text hay chưa)
          flushStream().catch(() => {});
        }
      },
      controller.signal,
      userId,
      selectedModel,
    );

    // Clear typing
    clearInterval(typingInterval);

    // Xử lý lỗi — hiển thị rõ loại lỗi
    if (response.error) {
      const hasPartial = response.text && response.text.length > 0;
      if (hasPartial) {
        // Có kết quả bán phần → gửi kèm thông báo lỗi
        await safeEditText(ctx.api, chatId, messageId, `${response.text}\n\n⚠️ ${response.error}`);
      } else {
        await safeEditText(ctx.api, chatId, messageId, `❌ ${errorLabel}: ${response.error}`);
      }
      // Cleanup trước khi return sớm — tránh AbortController bị orphan
      activeQueries.delete(userId);
      if (onComplete) { try { await onComplete(); } catch {} }
      return;
    }

    // Lưu session (ghi model thực tế đã dùng — response.model sau failover)
    if (!session && response.sessionId) {
      createSession(userId, response.sessionId, sessionTitle, response.model || selectedModel);
    } else if (session) {
      touchSession(userId, session.sessionId);
    }

    // Log query analytics (kèm model)
    const responseTimeMs = Date.now() - startTime;
    logQuery(
      userId,
      prompt,
      responseTimeMs,
      response.usage?.inputTokens || 0,
      response.usage?.outputTokens || 0,
      response.usage?.costUSD || 0,
      response.toolsUsed,
      response.model || "",
    );

    // Content filter — redact secrets trước khi gửi
    const safeText = sanitizeResponse(response.text);

    // Build final response with footer (tools + model tier + time)
    const elapsed = (responseTimeMs / 1000).toFixed(1);
    let fullResponse = safeText;
    const footerParts: string[] = [];
    if (response.toolsUsed.length > 0) {
      footerParts.push(formatToolsUsed(response.toolsUsed));
    }
    footerParts.push(`⏱ ${elapsed}s`);
    fullResponse += `\n\n---\n${footerParts.join("  |  ")}`;

    // Gửi kết quả cuối cùng
    const messages = splitMessage(fullResponse);

    // Edit message đầu tiên (thay thế progress)
    const firstMsg = messages[0] ?? fullResponse;
    const editOk = await safeEditText(ctx.api, chatId, messageId, firstMsg, "Markdown");
    if (!editOk) {
      // Edit fail → xóa và gửi mới
      await ctx.api.deleteMessage(chatId, messageId).catch(() => {});
      await safeSendMessage(ctx, firstMsg);
    }

    // Gửi phần còn lại
    for (let i = 1; i < messages.length; i++) {
      await safeSendMessage(ctx, messages[i]!);
    }

    // Tier 1: Extract facts từ conversation (async, không block UX)
    if (!response.error) {
      extractFacts(userId, prompt, response.text).catch(() => {});
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("❌ Message handler error:", errMsg);
    await safeEditText(ctx.api, chatId, messageId, `❌ ${errorLabel}: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
    activeQueries.delete(userId);
    // Cleanup callback (file deletion, etc.)
    if (onComplete) {
      try { await onComplete(); } catch {}
    }
  }
}

// ============================================================
// Handler: Text message — với streaming + queue + abort
// ============================================================

async function handleTextMessage(ctx: any): Promise<void> {
  const userId = ctx.from?.id;
  let text = ctx.message?.text;
  if (userId === undefined || !text) return;

  // Detect inline model override: "dùng opus ...", "use haiku ..."
  let modelOverride: string | undefined;
  const override = parseModelOverride(text);
  if (override) {
    const MODELS: Record<string, string> = {
      haiku: "claude-haiku-4-5-20251001",
      sonnet: "claude-sonnet-4-6",
      opus: "claude-opus-4-6",
    };
    modelOverride = MODELS[override.tier];
    text = override.rest || text; // giữ text gốc nếu chỉ có prefix
  }

  // Lane queue: chờ tin trước xong, max 3 tin trong queue
  withUserLock(userId, async () => {
    await ctx.replyWithChatAction("typing");
    const processingMsg = await ctx.reply("⏳ Đang xử lý...");

    const sessionTitle = text.length > 50 ? text.slice(0, 50) + "..." : text;

    await handleQueryWithStreaming({
      prompt: text,
      userId,
      ctx,
      chatId: ctx.chat.id,
      messageId: processingMsg.message_id,
      sessionTitle,
      errorLabel: "Đã xảy ra lỗi",
      modelOverride,
    });
  }, async () => {
    await ctx.reply("⚠️ Queue đầy (đang xử lý 3 tin). Vui lòng chờ hoặc /stop.");
  });
}

// ============================================================
// Handler: File — với session + progress
// ============================================================

async function handleDocument(ctx: any): Promise<void> {
  const userId = ctx.from?.id;
  const doc = ctx.message?.document;
  const caption = ctx.message?.caption || "Phân tích file này";
  if (userId === undefined || !doc) return;

  withUserLock(userId, async () => {
    await ctx.replyWithChatAction("typing");
    const safeName = sanitizeFilename(doc.file_name);
    const processingMsg = await ctx.reply(`📄 Đang tải file ${safeName}...`);
    const chatId = ctx.chat.id;
    const msgId = processingMsg.message_id;

    try {
      // Download file
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const fileResponse = await fetch(fileUrl);
      const fileBuffer = await fileResponse.arrayBuffer();

      const tempDir = `${config.claudeWorkingDir}/.telegram-uploads`;
      const tempPath = `${tempDir}/${safeName}`;
      await Bun.write(tempPath, fileBuffer);

      await safeEditText(ctx.api, chatId, msgId, `📄 Đã tải ${safeName}, đang phân tích...`);

      const prompt = `File "${safeName}" đã được lưu tại .telegram-uploads/${safeName}\n\nYêu cầu: ${caption}`;

      await handleQueryWithStreaming({
        prompt,
        userId,
        ctx,
        chatId,
        messageId: msgId,
        sessionTitle: `📄 ${safeName}`,
        errorLabel: "Lỗi xử lý file",
        onComplete: async () => {
          const fs = await import("fs/promises");
          await fs.unlink(tempPath);
        },
      });
    } catch (error) {
      // Lỗi download file (trước khi vào streaming)
      const errMsg = error instanceof Error ? error.message : String(error);
      await safeEditText(ctx.api, chatId, msgId, `❌ Lỗi xử lý file: ${errMsg}`);
    }
  });
}

// ============================================================
// Handler: Photo — với session + progress
// ============================================================

async function handlePhoto(ctx: any): Promise<void> {
  const userId = ctx.from?.id;
  const photos = ctx.message?.photo;
  const caption = ctx.message?.caption || "Phân tích ảnh này";
  if (userId === undefined || !photos || photos.length === 0) return;

  withUserLock(userId, async () => {
    await ctx.replyWithChatAction("typing");
    const processingMsg = await ctx.reply("🖼 Đang tải ảnh...");
    const chatId = ctx.chat.id;
    const msgId = processingMsg.message_id;

    try {
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const imgResponse = await fetch(fileUrl);
      const imgBuffer = await imgResponse.arrayBuffer();
      const fileName = `photo_${Date.now()}.jpg`;
      const tempDir = `${config.claudeWorkingDir}/.telegram-uploads`;
      const tempPath = `${tempDir}/${fileName}`;
      await Bun.write(tempPath, imgBuffer);

      await safeEditText(ctx.api, chatId, msgId, "🖼 Đã tải ảnh, đang phân tích...");

      const prompt = `Ảnh đã được lưu tại .telegram-uploads/${fileName}\n\nYêu cầu: ${caption}`;

      await handleQueryWithStreaming({
        prompt,
        userId,
        ctx,
        chatId,
        messageId: msgId,
        sessionTitle: `🖼 Ảnh: ${caption.slice(0, 40)}`,
        errorLabel: "Lỗi xử lý ảnh",
        onComplete: async () => {
          const fs = await import("fs/promises");
          await fs.unlink(tempPath);
        },
      });
    } catch (error) {
      // Lỗi download ảnh (trước khi vào streaming)
      const errMsg = error instanceof Error ? error.message : String(error);
      await safeEditText(ctx.api, chatId, msgId, `❌ Lỗi xử lý ảnh: ${errMsg}`);
    }
  });
}
