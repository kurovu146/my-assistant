// src/telegram/middleware.ts
// ============================================================
// Middleware — Xác thực user
// ============================================================
// Middleware là gì?
// → Hàm chạy TRƯỚC khi xử lý tin nhắn
// → Giống bảo vệ cửa: kiểm tra trước, cho vào sau
//
// Flow: Tin nhắn → authMiddleware → handler
//       Nếu middleware không gọi next() → tin nhắn bị chặn
// ============================================================

import type { Context, NextFunction } from "grammy";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

/**
 * Middleware xác thực user.
 *
 * Kiểm tra Telegram user ID có nằm trong whitelist không.
 * Nếu không → trả lời "không có quyền" và dừng.
 * Nếu có → gọi next() để tiếp tục xử lý.
 *
 * Whitelist rỗng chỉ xảy ra khi khai báo ALLOW_ALL_USERS=1 — config.ts đã chặn
 * trường hợp quên set (xem parseAllowedUsers), nên ở đây rỗng = cố ý mở cho dev.
 *
 * @example
 * // .env
 * TELEGRAM_ALLOWED_USERS=123456789        // 1 user
 * TELEGRAM_ALLOWED_USERS=123456,789012    // nhiều user
 * ALLOW_ALL_USERS=1                        // tất cả (dev mode, phải khai báo rõ)
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
    logger.log(`⛔ Unauthorized: user ${userId} (${ctx.from?.username})`);
    await ctx.reply("⛔ Bạn không có quyền sử dụng bot này.");
    return; // KHÔNG gọi next() → chặn tại đây
  }

  // User hợp lệ → cho đi tiếp
  await next();
}
