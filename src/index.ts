// src/index.ts
// ============================================================
// Entry Point — Khởi động bot
// ============================================================
// Chạy: bun run src/index.ts
// Dev:  bun --watch run src/index.ts (auto-reload khi sửa code)
//
// File này làm 3 việc:
// 1. In thông tin cấu hình (để debug)
// 2. Kiểm tra auth (đã login Claude chưa?)
// 3. Tạo bot và bắt đầu lắng nghe
// ============================================================

import { createBot } from "./bot/telegram.ts";
import { config } from "./config.ts";
import { checkAuth } from "./agent/claude.ts";
import { startWebMonitor, stopWebMonitor } from "./services/web-monitor.ts";
import { startMemoryConsolidation, stopMemoryConsolidation } from "./services/memory-consolidation.ts";
import { startNewsDigest, stopNewsDigest } from "./services/news-digest.ts";
import type { Bot } from "grammy";

// Xóa CLAUDECODE để tránh "nested session" error khi chạy qua PM2
// PM2 lưu env từ lần chạy trước, SDK set CLAUDECODE=1 → lần sau CLI nghĩ đang nested
delete process.env.CLAUDECODE;

// Giữ reference để stop sạch khi shutdown
let bot: Bot | undefined;

async function main() {
  // 1. In thông tin cấu hình
  console.log("🤖 Claude Telegram Agent");
  console.log("========================");
  console.log(`📍 Model:     ${config.claudeModel}`);
  console.log(`📂 Workspace: ${config.claudeWorkingDir}`);
  console.log(`🔑 Auth:      ${config.authMode}`);
  console.log(
    `👤 Users:     ${
      config.allowedUsers.length > 0
        ? config.allowedUsers.join(", ")
        : "TẤT CẢ (dev mode)"
    }`,
  );
  console.log("========================\n");

  // 2. Kiểm tra auth — dừng sớm nếu chưa login
  const auth = await checkAuth();
  console.log(`🔐 ${auth.message}\n`);
  if (!auth.ok) {
    process.exit(1);
  }

  // 3. Tạo thư mục uploads nếu chưa có
  const uploadDir = `${config.claudeWorkingDir}/.telegram-uploads`;
  await Bun.write(`${uploadDir}/.gitkeep`, "");

  // 4. Tạo bot
  bot = createBot();

  // 5. Đăng ký menu commands trong Telegram
  //    User sẽ thấy danh sách lệnh khi gõ /
  await bot.api.setMyCommands([
    { command: "start", description: "Bắt đầu / Hướng dẫn" },
    { command: "new", description: "Phiên hội thoại mới" },
    { command: "resume", description: "Tiếp tục phiên cũ" },
    { command: "status", description: "Xem trạng thái & thống kê" },
    { command: "stop", description: "Dừng query đang chạy" },
    { command: "reload", description: "Reload skills" },
    { command: "memory", description: "Xem bộ nhớ dài hạn" },
    { command: "monitor", description: "Theo dõi webpage thay đổi" },
    { command: "unmonitor", description: "Bỏ theo dõi webpage" },
    { command: "monitors", description: "Danh sách đang theo dõi" },
  ]);

  // 6. Xóa webhook cũ + drop pending updates
  //    FIX: Khi restart (bun --watch), instance cũ có thể vẫn đang poll.
  //    deleteWebhook ép Telegram reset polling state → instance mới poll clean.
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  // 7. Start cron services
  if (config.allowedUsers.length > 0) {
    const chatId = config.allowedUsers[0]!;
    const sendTelegram = async (message: string) => {
      try {
        await bot!.api.sendMessage(chatId, message);
      } catch (err) {
        console.error("❌ Notify error:", err);
      }
    };

    // Web Monitor — check mỗi 30 phút
    startWebMonitor(sendTelegram);

    // Memory Consolidation — gộp facts mỗi 24h
    startMemoryConsolidation(config.allowedUsers);

    // News Digest — gửi tin tức mỗi sáng 8h VN
    startNewsDigest(sendTelegram);
  }

  console.log("✅ Bot đã sẵn sàng! Đang lắng nghe tin nhắn...\n");

  // 8. Bắt đầu polling
  bot.start({
    onStart: (botInfo) => {
      console.log(`🚀 @${botInfo.username} đang chạy!`);
    },
  });
}

// --- Xử lý tắt sạch ---
// Khi Ctrl+C hoặc --watch restart, gọi bot.stop() trước
// để giải phóng polling connection → instance mới không bị 409 Conflict

async function shutdown() {
  console.log("\n👋 Đang tắt bot...");
  stopWebMonitor();
  stopMemoryConsolidation();
  stopNewsDigest();
  if (bot) {
    await bot.stop();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Chạy ---
main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
