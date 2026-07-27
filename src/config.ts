// src/config.ts

import { homedir } from "os";
import { logger } from "./logger.ts";

function fail(message: string): never {
  logger.error(`❌ ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.error(`   Hãy tạo file .env theo mẫu .env.example`);
    fail(`Thiếu biến môi trường: ${name}`);
  }
  return value;
}

/** Parse số nguyên dương từ env — sai định dạng thì dừng bot thay vì chạy với NaN */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} phải là số nguyên dương, đang là: "${raw}"`);
  }
  return value;
}

/**
 * Parse whitelist user ID.
 * Fail-closed: rỗng → dừng bot, trừ khi ALLOW_ALL_USERS=1 (chỉ dùng khi dev).
 * Bot chạy agent với quyền shell nên whitelist rỗng = bất kỳ ai cũng chạy được lệnh trên máy.
 */
function parseAllowedUsers(): number[] {
  const raw = (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = raw.filter((s) => !/^\d+$/.test(s));
  if (invalid.length > 0) {
    fail(`TELEGRAM_ALLOWED_USERS chứa ID không hợp lệ: ${invalid.join(", ")}`);
  }

  const ids = raw.map(Number);
  if (ids.length === 0 && process.env.ALLOW_ALL_USERS !== "1") {
    logger.error("   Bot chạy agent với quyền shell — whitelist rỗng nghĩa là ai cũng dùng được.");
    logger.error("   Set TELEGRAM_ALLOWED_USERS=<your-id>, hoặc ALLOW_ALL_USERS=1 nếu cố ý mở.");
    fail("TELEGRAM_ALLOWED_USERS trống");
  }
  return ids;
}

/** Expand ~ thành home directory — cross-platform (Mac/Linux) */
function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return path.replace("~", homedir());
  }
  return path;
}

export const config = {
  // Telegram
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  allowedUsers: parseAllowedUsers(),

  // Claude
  authMode: process.env.ANTHROPIC_API_KEY
    ? ("api-key" as const)
    : ("subscription" as const),
  claudeModel: process.env.CLAUDE_MODEL || "claude-opus-4-6",
  claudeWorkingDir: expandHome(process.env.CLAUDE_WORKING_DIR || process.cwd()),
  // Agent tuning — 30 turns đủ cho task phức tạp (research, multi-file)
  maxTurns: envInt("CLAUDE_MAX_TURNS", 30),

  // Session
  sessionTimeoutHours: envInt("SESSION_TIMEOUT_HOURS", 72),

  // Gmail — hỏi xác nhận qua Telegram trước khi gửi/xóa email (GMAIL_REQUIRE_CONFIRM=0 để tắt)
  gmailRequireConfirm: process.env.GMAIL_REQUIRE_CONFIRM !== "0",
};
