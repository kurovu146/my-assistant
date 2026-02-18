// src/bot/commands.ts
// ============================================================
// Commands — Xử lý các lệnh Telegram
// ============================================================
// Telegram bot commands bắt đầu bằng /
// User gõ /start → bot gọi handleStart()
// User gõ /new   → bot gọi handleNew()
// ...
//
// File này chỉ chứa logic xử lý lệnh.
// Việc đăng ký lệnh nào gọi hàm nào nằm ở telegram.ts
// ============================================================

import type { Context } from "grammy";
import {
  clearActiveSession,
  getActiveSession,
  getRecentSessions,
  setActiveSession,
} from "../storage/db.ts";
import { timeAgo } from "./formatter.ts";
import { config } from "../config.ts";
import { reloadSkills, getCumulativeUsage } from "../agent/claude.ts";
import { loadSkills } from "../agent/skills.ts";

// Bot start time — để tính uptime
const botStartTime = Date.now();

// --- Tracking active queries ---
// Map<userId, AbortController>
// Khi user gõ /stop, lấy controller ra và .abort()
export const activeQueries = new Map<number, AbortController>();

/**
 * /start — Chào mừng và hướng dẫn sử dụng
 * Gọi khi user nhắn bot lần đầu tiên.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const name = ctx.from?.first_name || "bạn";

  await ctx.reply(
    `👋 Xin chào ${name}!\n\n` +
      `Tôi là trợ lý AI cá nhân, sẵn sàng giúp bạn:\n\n` +
      `💻 Lập trình — review code, debug, viết code\n` +
      `🔍 Nghiên cứu — tìm kiếm, tổng hợp thông tin\n` +
      `📁 File — đọc, phân tích file bạn gửi\n\n` +
      `Lệnh:\n` +
      `/new — Phiên hội thoại mới\n` +
      `/resume — Tiếp tục phiên cũ\n` +
      `/stop — Dừng query đang chạy\n` +
      `/status — Xem trạng thái\n` +
      `/reload — Reload skills\n\n` +
      `Gửi tin nhắn bất kỳ để bắt đầu! 🚀`,
  );
}

/**
 * /new — Bắt đầu phiên hội thoại mới
 *
 * Xóa active session → lần nhắn tiếp sẽ tạo phiên mới.
 * Session cũ vẫn còn trong DB, có thể /resume sau.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  clearActiveSession(userId);
  await ctx.reply("🆕 Đã tạo phiên mới. Gửi tin nhắn để bắt đầu!");
}

/**
 * /resume — Hiển thị danh sách phiên cũ để chọn tiếp tục
 *
 * Hiện 5 phiên gần nhất dưới dạng inline keyboard.
 * User bấm vào phiên nào → handleResumeCallback() xử lý.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const sessions = getRecentSessions(userId);

  if (sessions.length === 0) {
    await ctx.reply("📭 Chưa có phiên nào. Gửi tin nhắn để bắt đầu!");
    return;
  }

  // Tạo inline keyboard — mỗi session là 1 nút bấm
  const keyboard = sessions.map((session) => [
    {
      text: `📝 ${session.title} (${timeAgo(session.lastActiveAt)})`,
      callback_data: `resume:${session.sessionId}`,
    },
  ]);

  await ctx.reply("📋 Chọn phiên để tiếp tục:", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Xử lý khi user bấm nút chọn session từ /resume
 *
 * callback_data có dạng "resume:session-id-xxx"
 * → Tách lấy sessionId → setActiveSession()
 */
export async function handleResumeCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  // Lấy callback data từ nút bấm
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("resume:")) return;

  // Tách session ID
  const sessionId = data.replace("resume:", "");
  setActiveSession(userId, sessionId);

  // Trả lời callback (xóa loading spinner trên nút)
  await ctx.answerCallbackQuery({ text: "✅ Đã resume phiên" });
  await ctx.reply("🔄 Đã tiếp tục phiên trước. Gửi tin nhắn để tiếp!");
}

/**
 * /status — Xem trạng thái hiện tại
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const isProcessing = activeQueries.has(userId);
  const session = getActiveSession(userId);
  const uptime = formatUptime(Date.now() - botStartTime);

  const statusText = isProcessing
    ? "⏳ Đang xử lý query..."
    : "✅ Sẵn sàng nhận lệnh";

  const sessionInfo = session
    ? `📝 Session: ${session.title}\n   Tạo: ${timeAgo(session.createdAt)}`
    : "📝 Session: không có (gửi tin nhắn để tạo mới)";

  // Skills count
  let skillInfo = "📚 Skills: 0";
  try {
    const skills = await loadSkills();
    const count = skills ? (skills.match(/<!-- skill:/g) || []).length : 0;
    skillInfo = `📚 Skills: ${count} loaded`;
  } catch {
    skillInfo = "📚 Skills: error";
  }

  // Token usage
  const usage = getCumulativeUsage();
  const usageInfo =
    usage.queryCount > 0
      ? `📈 Token usage (từ lúc khởi động):\n` +
        `   Queries: ${usage.queryCount}\n` +
        `   Input: ${formatTokenCount(usage.totalInputTokens)}\n` +
        `   Output: ${formatTokenCount(usage.totalOutputTokens)}\n` +
        `   Cost: $${usage.totalCostUSD.toFixed(4)}`
      : `📈 Token usage: chưa có query nào`;

  await ctx.reply(
    `📊 Trạng thái\n\n` +
      `${statusText}\n` +
      `⏱ Uptime: ${uptime}\n\n` +
      `🤖 Model: ${config.claudeModel}\n` +
      `🔑 Auth: ${config.authMode}\n` +
      `📂 Workspace: ${config.claudeWorkingDir}\n` +
      `${skillInfo}\n\n` +
      `${usageInfo}\n\n` +
      `${sessionInfo}`,
  );
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

/**
 * /reload — Reload skills mà không cần restart bot
 */
export async function handleReload(ctx: Context): Promise<void> {
  reloadSkills();
  await ctx.reply("🔄 Skills đã được reload! Thay đổi sẽ có hiệu lực từ tin nhắn tiếp theo.");
}

/**
 * /stop — Dừng query đang chạy
 *
 * Lấy AbortController của user từ activeQueries
 * và gọi .abort() để hủy request tới Claude.
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const controller = activeQueries.get(userId);
  if (controller) {
    controller.abort();
    activeQueries.delete(userId);
    await ctx.reply("⏹ Đã dừng query.");
  } else {
    await ctx.reply("ℹ️ Không có query nào đang chạy.");
  }
}
