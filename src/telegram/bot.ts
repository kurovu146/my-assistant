// src/telegram/bot.ts
// ============================================================
// Telegram Bot — Xử lý tin nhắn và kết nối với Claude
// ============================================================

import { statSync } from "fs";
import { Bot, type Api, type Context, type Filter } from "grammy";
import { config } from "../config.ts";
import { getClaudeProvider } from "../claude/provider.ts";
import { parseModelOverride, resolveModelTier } from "../claude/router.ts";
import { getActiveSession, createSession, touchSession } from "../db/sessions.ts";
import { getCurrentProject, getProjectCwd } from "../db/projects.ts";
import { getUserModel } from "../db/user-model.ts";
import { logQuery } from "../db/queries.ts";
import { splitMessage, formatUsageTotal, TOOL_ICONS } from "./formatter.ts";
import { sanitizeResponse } from "./content-filter.ts";
import { extractFacts } from "../memory/extraction.ts";
import { noteTurn, reviewSkills } from "../memory/skill-review.ts";
import { authMiddleware } from "./middleware.ts";
import { logger } from "../logger.ts";
import {
  handleStart,
  handleNew,
  handleResume,
  handleResumeCallback,
  handleStatus,
  handleUsage,
  handleStop,
  handleMemory,
  handleForget,
  handleModel,
  handleModelCallback,
  handleNews,
  handleProject,
} from "./commands.ts";
import {
  acquireSlot,
  hasFreeSlot,
  markQueryStarted,
  registerQuery,
  runInLane,
  runningCount,
  unregisterQuery,
} from "./lanes.ts";

// ============================================================
// Sanitize filename — prevent path traversal attacks
// ============================================================

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
}

// ============================================================
// File/ảnh user gửi lên
// ============================================================

/** Nơi chứa file user gửi lên — luôn ở thư mục gốc, KHÔNG theo project đang mở. */
export const UPLOAD_DIR = `${config.claudeWorkingDir}/.telegram-uploads`;

export function uploadPath(fileName: string): string {
  return `${UPLOAD_DIR}/${fileName}`;
}

/**
 * Ghi lại phiên sau mỗi lượt trả lời.
 *
 * So theo session id chứ không theo "trước đó đã có phiên hay chưa": provider có thể
 * đã phải bỏ phiên cũ giữa chừng vì không resume được. Nếu chỉ touch phiên cũ trong
 * trường hợp đó thì id mới không bao giờ vào `active_sessions`, và mỗi tin nhắn sau
 * lại mở thêm một phiên nữa — mạch hội thoại không bao giờ nối lại được.
 */
export function persistSession(
  userId: number,
  project: string,
  previousSessionId: string | undefined,
  returnedSessionId: string,
  title: string,
  model?: string,
): void {
  if (returnedSessionId && returnedSessionId !== previousSessionId) {
    createSession(userId, project, returnedSessionId, title, model);
  } else if (previousSessionId) {
    touchSession(userId, previousSessionId);
  }
}

/**
 * Thư mục làm việc cho một query.
 *
 * Lấy từ đường dẫn đã chốt trong registry, KHÔNG phân giải lại từ tên project:
 * Claude Agent SDK lưu transcript theo cwd nên cwd đổi giữa chừng là phiên chết
 * (xem ensureProject). `undefined` = dùng config.claudeWorkingDir.
 *
 * Nhưng thư mục đã chốt có thể biến mất SAU khi chốt (bị xoá/đổi tên thủ công,
 * hoặc bởi chính agent — nó chạy Bash bypassPermissions ngay trong đó). Đưa thẳng
 * một đường dẫn chết cho SDK làm nó không spawn được process và ném một lỗi
 * hoàn toàn không liên quan (kiểu libc/binary mismatch) mà lưới an toàn
 * `isSessionNotFoundError`/`isRetryableError` không khớp — bot kẹt cứng vĩnh viễn
 * cho project đó, không có đường tự phục hồi vì `projects.path` write-once. Nên
 * phải kiểm thư mục còn thật sự tồn tại NGAY LÚC CHẠY và lùi về thư mục gốc nếu
 * không — không được ghi đè `projects.path` (giữ nguyên tính đóng băng).
 */
export function resolveQueryCwd(project: string): string | undefined {
  if (!project) return undefined;
  const cwd = getProjectCwd(project);
  if (!cwd) return undefined;

  try {
    if (statSync(cwd).isDirectory()) return cwd;
  } catch {
    // ENOENT hoặc không có quyền đọc — coi như thư mục đã mất.
  }

  // Lùi cwd cũng là đổi cwd: phiên đang treo của project này (nếu có) sẽ không
  // resume được nữa, nhưng đó là lưới an toàn F-1 phần B (isSessionNotFoundError)
  // đã lo — không cần cơ chế dọn thứ hai ở đây.
  logger.error(
    `⚠️ Thư mục đã chốt của project "${project}" không còn tồn tại (${cwd}) — lùi về ${config.claudeWorkingDir}`,
  );
  return undefined;
}

/**
 * Prompt báo cho agent biết file vừa tải về nằm ở đâu.
 *
 * Đường dẫn phải TUYỆT ĐỐI. File luôn được ghi vào thư mục gốc, còn cwd của agent là
 * thư mục project đang mở — đường dẫn tương đối `.telegram-uploads/x` sẽ trỏ vào
 * `~/dev/<project>/.telegram-uploads/x`, chỗ không có gì, và agent mở đầu bằng ENOENT.
 */
export function buildUploadPrompt(label: string, fileName: string, caption: string): string {
  return `${label} đã được lưu tại ${uploadPath(fileName)}\n\nYêu cầu: ${caption}`;
}

// ============================================================
// Nhãn project + phát hiện tin đã trôi
// ============================================================

/**
 * Dòng nhãn đứng đầu tin tiến trình. Rỗng khi đang trò chuyện chung — lúc đó
 * không có gì để phân biệt nên thêm nhãn chỉ tổ ồn.
 */
export function progressHeader(project: string): string {
  return project ? `📁 ${project}\n` : "";
}

/** Tiền tố `[tên] ` cho dòng ping, rỗng khi đang trò chuyện chung. */
export function pingLabel(project: string): string {
  return project ? `[${project}] ` : "";
}

/**
 * ID tin nhắn mới nhất từng thấy trong mỗi chat — cả tin anh gửi lẫn tin bot gửi.
 *
 * Telegram cấp message_id tăng dần theo từng chat, nên "tin X có còn ở đáy chat
 * không" chỉ là so sánh số. Đây là cách duy nhất bot biết được kết quả của một
 * query chạy nền đã bị đẩy lên trên hay chưa: Bot API không có lệnh nào hỏi
 * "tin nào đang ở cuối chat".
 */
const lastSeenMessage = new Map<number, number>();

export function noteChatMessage(chatId: number, messageId: number): void {
  const seen = lastSeenMessage.get(chatId) ?? 0;
  if (messageId > seen) lastSeenMessage.set(chatId, messageId);
}

/**
 * Tin `messageId` đã bị đẩy lên trên (có tin mới hơn nằm dưới nó) hay chưa.
 *
 * Dùng để quyết định có ping hay không, thay vì so "project này có phải project
 * anh đang đứng không". So theo vị trí đúng hơn hẳn: anh /p rời đi rồi /p quay
 * lại đúng project đó thì kết quả vẫn nằm tít trên, vẫn cần ping.
 */
export function wasPushedUp(chatId: number, messageId: number): boolean {
  return (lastSeenMessage.get(chatId) ?? 0) > messageId;
}

/** Chỉ dùng trong test — bảng trên sống suốt đời process. */
export function __resetChatActivity(): void {
  lastSeenMessage.clear();
}

// ============================================================
// Tạo Bot
// ============================================================

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  bot.use(authMiddleware);

  // Ghi nhận mọi tin nhắn đi vào — mốc để biết kết quả của query chạy nền có bị
  // đẩy lên trên hay không. Đặt sau authMiddleware để tin của người lạ không
  // làm nhiễu mốc.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== undefined && ctx.message?.message_id !== undefined) {
      noteChatMessage(ctx.chat.id, ctx.message.message_id);
    }
    await next();
  });

  bot.command("start", handleStart);
  bot.command("p", handleProject);
  bot.command("new", handleNew);
  bot.command("resume", handleResume);
  bot.command("model", handleModel);
  bot.command("status", handleStatus);
  bot.command("usage", handleUsage);
  bot.command("stop", handleStop);
  bot.command("memory", handleMemory);
  bot.command("forget", handleForget);
  bot.command("news", handleNews);

  bot.callbackQuery(/^resume:/, handleResumeCallback);
  bot.callbackQuery(/^model:/, handleModelCallback);

  bot.on("message:text", handleTextMessage);
  bot.on("message:document", handleDocument);
  bot.on("message:photo", handlePhoto);

  bot.catch((err) => {
    const msg = err.message || String(err);
    // 409 = polling conflict → sẽ được xử lý bởi startPollingWithRecovery
    if (msg.includes("409")) {
      logger.error("⚠️ Polling conflict (409):", msg);
    } else {
      logger.error("❌ Bot error:", msg);
    }
  });

  return bot;
}

// ============================================================
// Safe message edit — handle Telegram API errors gracefully
// ============================================================

async function safeEditText(
  api: Api,
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: "Markdown",
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

/** Gửi tin, tự hạ xuống plain text nếu Markdown hỏng. Ghi nhận id để biết tin nào ở đáy chat. */
async function safeSendMessage(ctx: Context, text: string, replyTo?: number): Promise<void> {
  // allow_sending_without_reply: tin được trỏ tới có thể đã bị xoá (edit hỏng →
  // nhánh xoá-rồi-gửi-lại bên dưới), lúc đó vẫn phải gửi được thay vì ném 400.
  const extra = replyTo
    ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    : {};
  let sent;
  try {
    sent = await ctx.reply(text, { parse_mode: "Markdown", ...extra });
  } catch {
    sent = await ctx.reply(text, extra);
  }
  if (ctx.chat?.id !== undefined) noteChatMessage(ctx.chat.id, sent.message_id);
}

// ============================================================
// handleQueryWithStreaming — Common streaming logic cho tất cả handlers
// ============================================================
//
// Chứa toàn bộ logic chung:
// - AbortController + sổ query đang chạy (lanes.ts)
// - Van giới hạn số project chạy song song
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
  /**
   * Project của lượt này — chốt từ lúc NHẬN tin nhắn, không tra lại ở đây.
   *
   * Tra lại tại chỗ là sai: tin xếp hàng có thể chạy vài phút sau, lúc đó anh đã
   * `/p` sang project khác và việc này sẽ chạy nhầm thư mục, nhầm phiên, nhầm memory.
   */
  project: string;
  /** Context object (grammy) */
  ctx: Context;
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
  const { prompt, userId, project, ctx, chatId, messageId, sessionTitle, errorLabel, onComplete, modelOverride } =
    options;
  const startTime = Date.now();
  const header = progressHeader(project);

  // finally luôn chạy kể cả khi return sớm → chỉ cho cleanup chạy đúng 1 lần
  let cleanupDone = false;
  const runCleanup = async () => {
    if (cleanupDone || !onComplete) return;
    cleanupDone = true;
    try {
      await onComplete();
    } catch (err) {
      logger.error("⚠️ Cleanup error:", err instanceof Error ? err.message : err);
    }
  };

  // AbortController — /stop sẽ abort signal này.
  // Ghi sổ NGAY, trước cả lúc xin slot: query còn đang xếp hàng chờ slot vẫn phải
  // /stop được, nếu không anh gõ /stop rồi mà nó vẫn chạy vài phút sau.
  const controller = new AbortController();
  registerQuery(userId, project, controller);

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
  let isThinking = false; // model đang suy nghĩ (có thể kéo dài hàng chục giây)

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
    } else if (isThinking) {
      suffix = "\n\n🤔 _Đang suy nghĩ..._";
    } else {
      suffix = "\n\n⏳ _Đang xử lý..._";
    }

    const idle = currentTool
      ? `${TOOL_ICONS[currentTool] || "🔧"} Đang dùng ${currentTool}...`
      : isThinking
        ? "🤔 Đang suy nghĩ..."
        : "⏳ Đang xử lý...";

    const displayText = preview
      ? (preview.length > 3800
          ? preview.slice(0, 3800) + "\n\n⏳ _Đang tiếp tục..._"
          : preview + suffix)
      : idle;

    await safeEditText(ctx.api, chatId, messageId, header + displayText, "Markdown");
    editPending = false;
  };

  // Nhả trong `finally` chung ở cuối — hàm này có nhiều nhánh return sớm, nhả tay
  // ở từng nhánh là kiểu chắc chắn sẽ quên một chỗ và treo slot vĩnh viễn.
  let releaseSlot: (() => void) | null = null;

  try {
    // Van giới hạn: quá nhiều project chạy cùng lúc thì chờ tới lượt. Báo rõ đang
    // CHỜ chứ không phải đang chạy — nếu không anh nhìn "Đang xử lý" đứng im hàng
    // phút và tưởng bot treo.
    if (!hasFreeSlot()) {
      await safeEditText(
        ctx.api,
        chatId,
        messageId,
        `${header}⏳ Đang chờ — ${runningCount()} project khác đang chạy`,
      );
    }

    releaseSlot = await acquireSlot(controller.signal);
    if (!releaseSlot) {
      // Bị /stop lúc còn xếp hàng — chưa gọi Claude lần nào nên không có gì để dọn.
      await safeEditText(ctx.api, chatId, messageId, `${header}⏹ Đã dừng khi đang chờ tới lượt.`);
      return;
    }
    markQueryStarted(userId, project, controller);

    const session = getActiveSession(userId, project);
    const sessionId = session?.sessionId;

    // Ưu tiên: override inline ("dùng opus ...") → model chọn qua /model → config.
    // Đặt ở đây nên áp dụng cho cả text, file và ảnh.
    const selectedModel: string | undefined = modelOverride || getUserModel(userId) || undefined;

    // Chốt một lần: skill review chạy sau đó phải fork trên ĐÚNG cwd của phiên,
    // vì SDK khoá transcript theo cwd — resolve lại lần hai có thể ra kết quả khác
    // (thư mục vừa bị xoá) và fork sẽ không tìm thấy phiên để đọc.
    const queryCwd = resolveQueryCwd(project);

    const response = await getClaudeProvider().query({
      prompt,
      sessionId,
      onProgress: async (update) => {
        if (update.type === "text_chunk") {
          streamedText += update.content;
          currentTool = ""; // text mới → clear tool indicator
          flushStream().catch(() => {});
        } else if (update.type === "tool_use") {
          currentTool = update.content;
          isThinking = false;
          // Luôn flush khi có tool mới (dù đã có text hay chưa)
          flushStream().catch(() => {});
        } else if (update.type === "thinking") {
          isThinking = true;
          flushStream().catch(() => {});
        }
      },
      abortSignal: controller.signal,
      userId,
      modelOverride: selectedModel,
      cwd: queryCwd,
      project,
    });

    // Clear typing
    clearInterval(typingInterval);

    // Tin kết quả đã bị đẩy lên trên chưa — phải chốt NGAY ĐÂY, trước khi bot gửi
    // thêm bất cứ tin nào, vì chính những tin đó cũng đẩy mốc "mới nhất" lên.
    const pushedUp = wasPushedUp(chatId, messageId);

    // Xử lý lỗi — hiển thị rõ loại lỗi
    if (response.error) {
      const hasPartial = response.text && response.text.length > 0;
      if (hasPartial) {
        // Có kết quả bán phần → gửi kèm thông báo lỗi
        await safeEditText(ctx.api, chatId, messageId, `${header}${response.text}\n\n⚠️ ${response.error}`);
      } else {
        await safeEditText(ctx.api, chatId, messageId, `${header}❌ ${errorLabel}: ${response.error}`);
      }
      if (pushedUp) {
        await safeSendMessage(ctx, `❌ ${pingLabel(project)}lỗi — bấm để xem ↖`, messageId);
      }
      return;
    }

    // Lưu session (ghi model thực tế đã dùng — response.model sau failover)
    persistSession(
      userId,
      project,
      session?.sessionId,
      response.sessionId,
      sessionTitle,
      response.model || selectedModel,
    );

    // Log query analytics (kèm model)
    const responseTimeMs = Date.now() - startTime;
    logQuery({
      userId,
      promptPreview: prompt,
      responseTimeMs,
      tokensIn: response.usage?.inputTokens ?? 0,
      tokensOut: response.usage?.outputTokens ?? 0,
      cacheRead: response.usage?.cacheReadTokens ?? 0,
      cacheWrite: response.usage?.cacheCreationTokens ?? 0,
      costUsd: response.usage?.costUSD ?? 0,
      toolsUsed: response.toolsUsed,
      model: response.model,
    });

    // Content filter — redact secrets trước khi gửi
    const safeText = sanitizeResponse(response.text);

    // Build final response with footer (token + time)
    const elapsed = (responseTimeMs / 1000).toFixed(1);
    let fullResponse = safeText;
    // Nhãn project nằm ở footer chứ không ở đầu tin: đọc trên mobile thì câu trả
    // lời phải là thứ đập vào mắt trước, còn "của project nào" chỉ cần khi anh
    // ngoái lại tìm.
    const footerParts: string[] = [];
    if (project) footerParts.push(`📁 ${project}`);
    const usageTotal = formatUsageTotal(response.usage);
    if (usageTotal) {
      footerParts.push(usageTotal);
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

    // Ping: kết quả nằm tít trên, anh sẽ không thấy nếu không được trỏ tới.
    // `editOk` sai nghĩa là kết quả vừa được gửi lại xuống đáy chat rồi — ping nữa
    // là thừa và trỏ vào một tin đã bị xoá.
    if (pushedUp && editOk) {
      await safeSendMessage(ctx, `✅ ${pingLabel(project)}xong — bấm để xem ↖`, messageId);
    }

    // Tier 1: Extract facts từ conversation (async, không block UX)
    if (!response.error) {
      extractFacts(userId, prompt, response.text, project).catch((e) => {
        logger.error("⚠️ extractFacts error:", e instanceof Error ? e.message : e);
      });

      // Tier 3: cứ N lượt fork phiên vừa xong để rút skill. Chạy SAU khi kết quả
      // đã tới tay anh Tuấn — giống hermes-agent, review không bao giờ được
      // tranh chỗ với câu trả lời.
      if (noteTurn(userId, project)) {
        reviewSkills({
          userId,
          sessionId: response.sessionId,
          project,
          cwd: queryCwd,
          model: response.model,
          onLearned: (summary) => {
            safeSendMessage(ctx, `🎓 Vừa học được:\n${summary}`).catch(() => {});
          },
        }).catch((e) => {
          logger.error("⚠️ reviewSkills error:", e instanceof Error ? e.message : e);
        });
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("❌ Message handler error:", errMsg);
    await safeEditText(ctx.api, chatId, messageId, `${header}❌ ${errorLabel}: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
    releaseSlot?.();
    unregisterQuery(userId, project, controller);
    // Cleanup callback (file deletion, etc.) — idempotent
    await runCleanup();
  }
}

// ============================================================
// Handler: Text message — với streaming + queue + abort
// ============================================================

async function handleTextMessage(ctx: Filter<Context, "message:text">): Promise<void> {
  const userId = ctx.from?.id;
  let text = ctx.message.text;
  if (userId === undefined || !text) return;

  // Detect inline model override: "dùng opus ...", "use fast ..."
  let modelOverride: string | undefined;
  const override = parseModelOverride(text);
  if (override) {
    modelOverride = resolveModelTier(override.tier);
    text = override.rest || text; // giữ text gốc nếu chỉ có prefix
  }

  // Chốt project NGAY LÚC NÀY, không để handleQueryWithStreaming tự tra: tin này
  // có thể nằm chờ vài phút, lúc chạy thì anh đã /p sang chỗ khác rồi.
  const project = getCurrentProject(userId);

  // Lane queue: chờ tin trước CỦA CÙNG PROJECT xong, max 3 tin trong queue.
  // Project khác chạy song song, không liên quan.
  runInLane(userId, project, async () => {
    await ctx.replyWithChatAction("typing");
    const processingMsg = await ctx.reply(`${progressHeader(project)}⏳ Đang xử lý...`);
    noteChatMessage(ctx.chat.id, processingMsg.message_id);

    const sessionTitle = text.length > 50 ? text.slice(0, 50) + "..." : text;

    await handleQueryWithStreaming({
      prompt: text,
      userId,
      project,
      ctx,
      chatId: ctx.chat.id,
      messageId: processingMsg.message_id,
      sessionTitle,
      errorLabel: "Đã xảy ra lỗi",
      modelOverride,
    });
  }, async () => {
    await ctx.reply(
      `⚠️ Queue đầy — ${project || "trò chuyện chung"} đang có 3 tin chờ. Chờ tí hoặc /stop.`,
    );
  });
}

// ============================================================
// Handler: File — với session + progress
// ============================================================

async function handleDocument(ctx: Filter<Context, "message:document">): Promise<void> {
  const userId = ctx.from?.id;
  const doc = ctx.message.document;
  const caption = ctx.message.caption || "Phân tích file này";
  if (userId === undefined || !doc) return;

  const project = getCurrentProject(userId);

  runInLane(userId, project, async () => {
    await ctx.replyWithChatAction("typing");
    // file_name là optional trong Bot API — thiếu tên vẫn phải xử lý được
    const safeName = sanitizeFilename(doc.file_name || `file_${Date.now()}`);
    const processingMsg = await ctx.reply(`${progressHeader(project)}📄 Đang tải file ${safeName}...`);
    const chatId = ctx.chat.id;
    const msgId = processingMsg.message_id;
    noteChatMessage(chatId, msgId);

    try {
      // Download file
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        throw new Error(`Tải file thất bại (HTTP ${fileResponse.status})`);
      }
      const fileBuffer = await fileResponse.arrayBuffer();

      const tempPath = uploadPath(safeName);
      await Bun.write(tempPath, fileBuffer);

      await safeEditText(
        ctx.api,
        chatId,
        msgId,
        `${progressHeader(project)}📄 Đã tải ${safeName}, đang phân tích...`,
      );

      const prompt = buildUploadPrompt(`File "${safeName}"`, safeName, caption);

      await handleQueryWithStreaming({
        prompt,
        userId,
        project,
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

async function handlePhoto(ctx: Filter<Context, "message:photo">): Promise<void> {
  const userId = ctx.from?.id;
  const photos = ctx.message.photo;
  const caption = ctx.message.caption || "Phân tích ảnh này";
  if (userId === undefined || !photos || photos.length === 0) return;

  const project = getCurrentProject(userId);

  runInLane(userId, project, async () => {
    await ctx.replyWithChatAction("typing");
    const processingMsg = await ctx.reply(`${progressHeader(project)}🖼 Đang tải ảnh...`);
    const chatId = ctx.chat.id;
    const msgId = processingMsg.message_id;
    noteChatMessage(chatId, msgId);

    try {
      const photo = photos[photos.length - 1]!;
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
      const imgResponse = await fetch(fileUrl);
      if (!imgResponse.ok) {
        throw new Error(`Tải ảnh thất bại (HTTP ${imgResponse.status})`);
      }
      const imgBuffer = await imgResponse.arrayBuffer();
      const fileName = `photo_${Date.now()}.jpg`;
      const tempPath = uploadPath(fileName);
      await Bun.write(tempPath, imgBuffer);

      await safeEditText(ctx.api, chatId, msgId, `${progressHeader(project)}🖼 Đã tải ảnh, đang phân tích...`);

      const prompt = buildUploadPrompt("Ảnh", fileName, caption);

      await handleQueryWithStreaming({
        prompt,
        userId,
        project,
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
