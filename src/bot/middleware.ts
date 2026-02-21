// src/bot/middleware.ts
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
