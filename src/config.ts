// src/config.ts

import type { ProviderName } from "./agent/provider-factory.ts";
import { homedir } from "os";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Thiếu biến môi trường: ${name}`);
    console.error(`   Hãy tạo file .env theo mẫu .env.example`);
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

  // --- Agent Provider ---
  // AGENT_PROVIDER chọn backend: claude | openai | gemini | ollama | deepseek
  // Không set → default "claude", backward compat với CLAUDE_* vars
  agentProvider: (process.env.AGENT_PROVIDER || "claude") as ProviderName,
  agentModel: process.env.AGENT_MODEL || "",         // empty = provider default
  agentApiKey: process.env.AGENT_API_KEY || "",       // API key (không cần cho claude subscription / ollama)
  agentBaseUrl: process.env.AGENT_BASE_URL || "",     // custom endpoint (cần cho ollama)

  // Claude-specific (backward compat)
  authMode: process.env.ANTHROPIC_API_KEY
    ? ("api-key" as const)
    : ("subscription" as const),
  claudeModel: process.env.CLAUDE_MODEL || "claude-opus-4-6",
  claudeWorkingDir: expandHome(process.env.CLAUDE_WORKING_DIR || process.cwd()),
  cliPath: process.env.CLAUDE_CLI_PATH || undefined,

  // Agent tuning — 30 turns đủ cho task phức tạp (research, multi-file)
  maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || "30"),

  // Session
  sessionTimeoutHours: parseInt(process.env.SESSION_TIMEOUT_HOURS || "72"),
};
