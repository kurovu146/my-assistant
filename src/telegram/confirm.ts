// src/telegram/confirm.ts
// ============================================================
// Confirmation — Hỏi chủ nhân trước khi làm việc không hoàn tác được
// ============================================================
// Agent chạy với bypassPermissions nên không có prompt permission nào.
// Các tool gửi ra ngoài / xóa dữ liệu (gmail_send, gmail_trash) đi qua đây:
// bot gửi inline keyboard cho owner và CHỜ bấm nút.
//
// Không có kênh hỏi (chưa install, chạy script CLI) → từ chối, không im lặng cho qua.
// ============================================================

import type { Bot } from "grammy";
import { logger } from "../logger.ts";

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
}

const TIMEOUT_MS = 2 * 60 * 1000;

let requester: ((question: string) => Promise<boolean>) | null = null;
const pending = new Map<string, (answer: boolean) => void>();
let nextId = 1;

/**
 * Hỏi owner. Trả về ok=false kèm lý do khi bị từ chối / hết giờ / không có kênh hỏi.
 */
export async function requestConfirm(question: string): Promise<ConfirmResult> {
  if (!requester) {
    return { ok: false, reason: "Không có kênh xác nhận với chủ nhân — hành động bị chặn." };
  }
  try {
    const approved = await requester(question);
    return approved
      ? { ok: true }
      : { ok: false, reason: "Chủ nhân từ chối hoặc không phản hồi trong 2 phút." };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("❌ Confirm error:", msg);
    return { ok: false, reason: `Lỗi khi hỏi xác nhận: ${msg}` };
  }
}

/**
 * Đăng ký kênh xác nhận qua Telegram cho 1 chat cụ thể (owner).
 * Gọi 1 lần lúc khởi động, sau khi bot đã tạo.
 */
export function installConfirm(bot: Bot, chatId: number): void {
  bot.callbackQuery(/^confirm:(yes|no):\d+$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split(":");
    const answer = parts[1] === "yes";
    const id = parts[2]!;

    const resolve = pending.get(id);
    pending.delete(id);

    await ctx.answerCallbackQuery({ text: answer ? "✅ Đã duyệt" : "❌ Đã hủy" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    if (resolve) {
      resolve(answer);
    } else {
      await ctx.reply("⚠️ Yêu cầu này đã hết hạn.");
    }
  });

  requester = (question) =>
    new Promise<boolean>((resolve) => {
      const id = String(nextId++);

      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(false);
      }, TIMEOUT_MS);

      pending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });

      bot.api
        .sendMessage(chatId, `🔐 Cần xác nhận:\n\n${question}\n\n_Tự hủy sau 2 phút._`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Đồng ý", callback_data: `confirm:yes:${id}` },
                { text: "❌ Hủy", callback_data: `confirm:no:${id}` },
              ],
            ],
          },
        })
        .catch((err) => {
          clearTimeout(timer);
          pending.delete(id);
          logger.error("❌ Không gửi được yêu cầu xác nhận:", err);
          resolve(false);
        });
    });

  logger.log("🔐 Confirmation channel installed");
}
