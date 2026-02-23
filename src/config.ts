// src/config.ts

import { homedir } from "os";
import { logger } from "./logger.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.error(`❌ Thiếu biến môi trường: ${name}`);
    logger.error(`   Hãy tạo file .env theo mẫu .env.example`);
    process.exit(1);
  }
  return value;
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
  allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map(Number)
    .filter(Boolean),

  // Claude
  authMode: process.env.ANTHROPIC_API_KEY
    ? ("api-key" as const)
    : ("subscription" as const),
  claudeModel: process.env.CLAUDE_MODEL || "claude-opus-4-6",
  claudeWorkingDir: expandHome(process.env.CLAUDE_WORKING_DIR || process.cwd()),
  // Agent tuning — 30 turns đủ cho task phức tạp (research, multi-file)
  maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || "30"),

  // Session
  sessionTimeoutHours: parseInt(process.env.SESSION_TIMEOUT_HOURS || "72"),
};
