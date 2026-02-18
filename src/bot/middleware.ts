// src/bot/middleware.ts
// ============================================================
// Middleware — Xác thực user và rate limiting
// ============================================================
// Middleware là gì?
// → Hàm chạy TRƯỚC khi xử lý tin nhắn
// → Giống bảo vệ cửa: kiểm tra trước, cho vào sau
//
// Flow: Tin nhắn → authMiddleware → rateLimitMiddleware → handler
//       Nếu middleware không gọi next() → tin nhắn bị chặn
// ============================================================

import type { Context, NextFunction } from "grammy";
import { config } from "../config.ts";

// --- Rate Limiter ---
// Lưu timestamps request gần đây của mỗi user
// Key: userId, Value: mảng timestamps

const userMessageTimestamps: Map<number, number[]> = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000; // Cleanup mỗi 5 phút

// Auto cleanup users không hoạt động — tránh memory leak
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userMessageTimestamps) {
    const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) {
      userMessageTimestamps.delete(userId);
    } else {
      userMessageTimestamps.set(userId, recent);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Middleware rate limiting per user.
 *
 * Giới hạn mỗi user tối đa 5 tin nhắn trong 60 giây.
 * Nếu vượt quá → trả lời thân thiện và dừng xử lý.
 * Timestamps cũ hơn 60s tự động bị loại bỏ.
 */
export function rateLimitMiddleware() {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();
    const timestamps = userMessageTimestamps.get(userId) || [];
    const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);

    if (recent.length >= RATE_LIMIT) {
      await ctx.reply(
        "Anh ơi, em cần nghỉ chút. Thử lại sau 1 phút nhé!",
      );
      return;
    }

    recent.push(now);
    userMessageTimestamps.set(userId, recent);
    return next();
  };
}

/**
 * Middleware xác thực user.
 *
 * Kiểm tra Telegram user ID có nằm trong whitelist không.
 * Nếu không → trả lời "không có quyền" và dừng.
 * Nếu có → gọi next() để tiếp tục xử lý.
 *
 * Nếu whitelist rỗng → cho phép tất cả (dev mode).
 * ⚠️ Chỉ để trống khi dev, production luôn set TELEGRAM_ALLOWED_USERS
 *
 * @example
 * // .env
 * TELEGRAM_ALLOWED_USERS=123456789        // 1 user
 * TELEGRAM_ALLOWED_USERS=123456,789012    // nhiều user
 * TELEGRAM_ALLOWED_USERS=                  // tất cả (dev mode)
 */
export async function authMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const userId = ctx.from?.id;

  // Bỏ qua tin nhắn không có user (ví dụ: channel posts)
  if (!userId) {
    return;
  }

  // Whitelist rỗng = cho tất cả vào (dev mode)
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId)) {
    console.log(`⛔ Unauthorized: user ${userId} (${ctx.from?.username})`);
    await ctx.reply("⛔ Bạn không có quyền sử dụng bot này.");
    return; // KHÔNG gọi next() → chặn tại đây
  }

  // User hợp lệ → cho đi tiếp
  await next();
}
