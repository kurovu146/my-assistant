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
import {
  getActiveSession,
  createSession,
  touchSession,
} from "../storage/db.ts";
import { splitMessage, formatToolsUsed, TOOL_ICONS } from "./formatter.ts";
import { authMiddleware, rateLimitMiddleware } from "./middleware.ts";
import {
  handleStart,
  handleNew,
  handleResume,
  handleResumeCallback,
  handleStatus,
  handleStop,
  handleReload,
  activeQueries,
} from "./commands.ts";

// ============================================================
// Sanitize filename — prevent path traversal attacks
// ============================================================

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
}

// ============================================================
// Per-user message queue — tránh overlap khi gửi 2 tin liên tục
// ============================================================

const userLocks = new Map<number, Promise<void>>();

/**
 * Queue handler per user.
 * Tin nhắn thứ 2 sẽ chờ tin 1 xong mới chạy.
 */
function withUserLock(userId: number, fn: () => Promise<void>): Promise<void> {
  const prev = userLocks.get(userId) || Promise.resolve();
  const current = prev.then(fn, fn); // chạy dù prev resolve hay reject
  userLocks.set(userId, current);
  // Cleanup khi xong
  current.finally(() => {
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

  bot.callbackQuery(/^resume:/, handleResumeCallback);

  bot.on("message:text", handleTextMessage);
  bot.on("message:document", handleDocument);
  bot.on("message:photo", handlePhoto);

  bot.catch((err) => {
    console.error("❌ Bot error:", err.message);
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
// Handler: Text message — với streaming + queue + abort
// ============================================================

async function handleTextMessage(ctx: any): Promise<void> {
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (userId === undefined || !text) return;

  // Queue: chờ tin trước xong
  withUserLock(userId, () => processMessage(ctx, userId, text));
}

async function processMessage(
  ctx: any,
  userId: number,
  text: string,
): Promise<void> {
  await ctx.replyWithChatAction("typing");
  const processingMsg = await ctx.reply("⏳ Đang xử lý...");
  const chatId = ctx.chat.id;
  const msgId = processingMsg.message_id;
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

    await safeEditText(ctx.api, chatId, msgId, displayText, "Markdown");
    editPending = false;
  };

  try {
    const session = getActiveSession(userId);
    const sessionId = session?.sessionId;

    const response = await askClaude(
      text,
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
    );

    // Clear typing
    clearInterval(typingInterval);

    // Xử lý lỗi
    if (response.error) {
      await safeEditText(ctx.api, chatId, msgId, `❌ Lỗi: ${response.error}`);
      return;
    }

    // Lưu session
    if (!session && response.sessionId) {
      const title = text.length > 50 ? text.slice(0, 50) + "..." : text;
      createSession(userId, response.sessionId, title);
    } else if (session) {
      touchSession(userId, session.sessionId);
    }

    // Build final response with footer (tools + time)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    let fullResponse = response.text;
    const footerParts: string[] = [];
    if (response.toolsUsed.length > 0) {
      footerParts.push(formatToolsUsed(response.toolsUsed));
    }
    footerParts.push(`⏱ ${elapsed}s`);
    fullResponse += `\n\n---\n${footerParts.join("  |  ")}`;

    // Gửi kết quả cuối cùng
    const messages = splitMessage(fullResponse);

    // Edit message đầu tiên (thay thế progress)
    const editOk = await safeEditText(ctx.api, chatId, msgId, messages[0], "Markdown");
    if (!editOk) {
      // Edit fail → xóa và gửi mới
      await ctx.api.deleteMessage(chatId, msgId).catch(() => {});
      await safeSendMessage(ctx, messages[0]);
    }

    // Gửi phần còn lại
    for (let i = 1; i < messages.length; i++) {
      await safeSendMessage(ctx, messages[i]);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("❌ Message handler error:", errMsg);
    await safeEditText(ctx.api, chatId, msgId, `❌ Đã xảy ra lỗi: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
    activeQueries.delete(userId);
  }
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

    const controller = new AbortController();
    activeQueries.set(userId, controller);

    const typingInterval = setInterval(async () => {
      try { await ctx.replyWithChatAction("typing"); } catch {}
    }, 4000);

    try {
      // Download file
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const fileResponse = await fetch(fileUrl);
      const fileBuffer = await fileResponse.arrayBuffer();

      const tempDir = `${config.claudeWorkingDir}/.telegram-uploads`;
      await Bun.write(`${tempDir}/${safeName}`, fileBuffer);

      await safeEditText(ctx.api, chatId, msgId, `📄 Đã tải ${safeName}, đang phân tích...`);
      const startTime = Date.now();

      // Use active session for context
      const session = getActiveSession(userId);
      const sessionId = session?.sessionId;

      // Streaming state (same pattern as text handler)
      let streamedText = "";
      let lastEditTime = 0;
      let editPending = false;
      let currentTool = "";

      const flushStream = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastEditTime < 1500) return;
        if (editPending) return;
        editPending = true;
        lastEditTime = now;
        const preview = streamedText.trim();
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
        await safeEditText(ctx.api, chatId, msgId, displayText, "Markdown");
        editPending = false;
      };

      const prompt = `File "${safeName}" đã được lưu tại .telegram-uploads/${safeName}\n\nYêu cầu: ${caption}`;
      const response = await askClaude(prompt, sessionId, (update) => {
        if (update.type === "text_chunk") {
          streamedText += update.content;
          currentTool = "";
          flushStream().catch(() => {});
        } else if (update.type === "tool_use") {
          currentTool = update.content;
          flushStream().catch(() => {});
        }
      }, controller.signal);

      // Save/touch session
      if (!session && response.sessionId) {
        createSession(userId, response.sessionId, `📄 ${safeName}`);
      } else if (session) {
        touchSession(userId, session.sessionId);
      }

      // Build result with footer
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      let fullResponse = response.error
        ? `❌ Lỗi: ${response.error}`
        : response.text;
      if (!response.error) {
        const fp: string[] = [];
        if (response.toolsUsed.length > 0) fp.push(formatToolsUsed(response.toolsUsed));
        fp.push(`⏱ ${elapsed}s`);
        fullResponse += `\n\n---\n${fp.join("  |  ")}`;
      }

      const messages = splitMessage(fullResponse);
      const editOk = await safeEditText(ctx.api, chatId, msgId, messages[0], "Markdown");
      if (!editOk) {
        await ctx.api.deleteMessage(chatId, msgId).catch(() => {});
        await safeSendMessage(ctx, messages[0]);
      }
      for (let i = 1; i < messages.length; i++) {
        await safeSendMessage(ctx, messages[i]);
      }

      // Cleanup temp file
      try {
        const fs = await import("fs/promises");
        await fs.unlink(`${tempDir}/${safeName}`);
      } catch {}
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await safeEditText(ctx.api, chatId, msgId, `❌ Lỗi xử lý file: ${errMsg}`);
    } finally {
      clearInterval(typingInterval);
      activeQueries.delete(userId);
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

    const controller = new AbortController();
    activeQueries.set(userId, controller);

    const typingInterval = setInterval(async () => {
      try { await ctx.replyWithChatAction("typing"); } catch {}
    }, 4000);

    try {
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const imgResponse = await fetch(fileUrl);
      const imgBuffer = await imgResponse.arrayBuffer();
      const fileName = `photo_${Date.now()}.jpg`;
      const tempDir = `${config.claudeWorkingDir}/.telegram-uploads`;
      await Bun.write(`${tempDir}/${fileName}`, imgBuffer);

      await safeEditText(ctx.api, chatId, msgId, "🖼 Đã tải ảnh, đang phân tích...");
      const startTime = Date.now();

      // Use active session
      const session = getActiveSession(userId);
      const sessionId = session?.sessionId;

      // Streaming state
      let streamedText = "";
      let lastEditTime = 0;
      let editPending = false;
      let currentTool = "";

      const flushStream = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastEditTime < 1500) return;
        if (editPending) return;
        editPending = true;
        lastEditTime = now;
        const preview = streamedText.trim();
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
        await safeEditText(ctx.api, chatId, msgId, displayText, "Markdown");
        editPending = false;
      };

      const prompt = `Ảnh đã được lưu tại .telegram-uploads/${fileName}\n\nYêu cầu: ${caption}`;
      const response = await askClaude(prompt, sessionId, (update) => {
        if (update.type === "text_chunk") {
          streamedText += update.content;
          currentTool = "";
          flushStream().catch(() => {});
        } else if (update.type === "tool_use") {
          currentTool = update.content;
          flushStream().catch(() => {});
        }
      }, controller.signal);

      if (!session && response.sessionId) {
        createSession(userId, response.sessionId, `🖼 Ảnh: ${caption.slice(0, 40)}`);
      } else if (session) {
        touchSession(userId, session.sessionId);
      }

      // Build result with footer
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      let fullResponse = response.error
        ? `❌ Lỗi: ${response.error}`
        : response.text;
      if (!response.error) {
        const fp: string[] = [];
        if (response.toolsUsed.length > 0) fp.push(formatToolsUsed(response.toolsUsed));
        fp.push(`⏱ ${elapsed}s`);
        fullResponse += `\n\n---\n${fp.join("  |  ")}`;
      }

      const messages = splitMessage(fullResponse);
      const editOk = await safeEditText(ctx.api, chatId, msgId, messages[0], "Markdown");
      if (!editOk) {
        await ctx.api.deleteMessage(chatId, msgId).catch(() => {});
        await safeSendMessage(ctx, messages[0]);
      }
      for (let i = 1; i < messages.length; i++) {
        await safeSendMessage(ctx, messages[i]);
      }

      // Cleanup
      try {
        const fs = await import("fs/promises");
        await fs.unlink(`${tempDir}/${fileName}`);
      } catch {}
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await safeEditText(ctx.api, chatId, msgId, `❌ Lỗi xử lý ảnh: ${errMsg}`);
    } finally {
      clearInterval(typingInterval);
      activeQueries.delete(userId);
    }
  });
}
