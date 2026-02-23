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
import { createProvider } from "./agent/provider-factory.ts";
import { registerProvider, getAgentProvider } from "./agent/provider-registry.ts";
import { startWebMonitor, stopWebMonitor } from "./services/web-monitor.ts";
import { startMemoryConsolidation, stopMemoryConsolidation } from "./services/memory-consolidation.ts";
import { startNewsDigest, stopNewsDigest } from "./services/news-digest.ts";
import { startSkillWatcher, stopSkillWatcher } from "./agent/skills.ts";
import type { Bot } from "grammy";
import { logger } from "./logger.ts";

// Xóa CLAUDECODE để tránh "nested session" error khi chạy qua PM2
// PM2 lưu env từ lần chạy trước, SDK set CLAUDECODE=1 → lần sau CLI nghĩ đang nested
delete process.env.CLAUDECODE;

// Giữ reference để stop sạch khi shutdown
let bot: Bot | undefined;

async function main() {
  // 1. Khởi tạo provider
  const provider = await createProvider();
  registerProvider(provider);

  // 2. In thông tin cấu hình
  logger.log("🤖 Telegram Agent");
  logger.log("========================");
  logger.log(`📍 Model:     ${config.claudeModel}`);
  logger.log(`📂 Workspace: ${config.claudeWorkingDir}`);
  logger.log(`🔑 Auth:      ${config.authMode}`);
  logger.log(
    `👤 Users:     ${
      config.allowedUsers.length > 0
        ? config.allowedUsers.join(", ")
        : "TẤT CẢ (dev mode)"
    }`,
  );
  logger.log("========================\n");

  // 3. Kiểm tra auth — dừng sớm nếu chưa login
  const auth = await getAgentProvider().checkAuth();
  logger.log(`🔐 ${auth.message}\n`);
  if (!auth.ok) {
    process.exit(1);
  }

  // 4. Tạo thư mục uploads nếu chưa có
  const uploadDir = `${config.claudeWorkingDir}/.telegram-uploads`;
  await Bun.write(`${uploadDir}/.gitkeep`, "");

  // 5. Tạo bot
  bot = createBot();

  // 6. Đăng ký menu commands trong Telegram
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

  // 7. Start cron services
  if (config.allowedUsers.length > 0) {
    const chatId = config.allowedUsers[0]!;
    const sendTelegram = async (message: string) => {
      try {
        await bot!.api.sendMessage(chatId, message);
      } catch (err) {
        logger.error("❌ Notify error:", err);
      }
    };

    // Web Monitor — check mỗi 30 phút
    startWebMonitor(sendTelegram);

    // Memory Consolidation — gộp facts mỗi 24h
    startMemoryConsolidation(config.allowedUsers);

    // News Digest — gửi tin tức mỗi sáng 8h VN
    startNewsDigest(sendTelegram);
  }

  // 8. Start skill watcher — auto-reload khi files thay đổi
  startSkillWatcher();

  logger.log("✅ Bot đã sẵn sàng! Đang lắng nghe tin nhắn...\n");

  // 9. Bắt đầu polling với auto-recovery
  startPollingWithRecovery(bot);
}

// --- Polling với auto-retry ---
// grammY polling loop crash (409 Conflict, network error...) → retry vài lần
// Nếu vẫn fail → exit để pm2 restart clean
const MAX_POLLING_RETRIES = 3;

async function startPollingWithRecovery(bot: Bot, attempt = 0) {
  try {
    // Mỗi lần retry đều clear polling state, nhưng chỉ drop pending ở lần đầu
    await bot.api.deleteWebhook({ drop_pending_updates: attempt === 0 });
    await bot.start({
      onStart: (botInfo) => {
        logger.log(`🚀 @${botInfo.username} đang chạy!`);
      },
    });
    // bot.start() resolve = bot.stop() được gọi → graceful shutdown, không retry
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`❌ Polling crashed (attempt ${attempt + 1}/${MAX_POLLING_RETRIES + 1}): ${msg}`);

    if (attempt < MAX_POLLING_RETRIES) {
      const delay = 5000 * (attempt + 1); // 5s, 10s, 15s
      logger.log(`🔄 Retry polling in ${delay / 1000}s...`);
      await Bun.sleep(delay);
      return startPollingWithRecovery(bot, attempt + 1);
    }

    logger.error("❌ Polling failed after retries — exiting (pm2 sẽ restart)");
    process.exit(1);
  }
}

// --- Xử lý tắt sạch ---
// Khi Ctrl+C hoặc --watch restart, gọi bot.stop() trước
// để giải phóng polling connection → instance mới không bị 409 Conflict

async function shutdown() {
  logger.log("\n👋 Đang tắt bot...");
  stopWebMonitor();
  stopMemoryConsolidation();
  stopNewsDigest();
  stopSkillWatcher();
  if (bot) {
    await bot.stop();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Chạy ---
main().catch((err) => {
  logger.error("❌ Fatal error:", err);
  process.exit(1);
});
