// src/config.ts

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Thiếu biến môi trường: ${name}`);
    console.error(`   Hãy tạo file .env theo mẫu .env.example`);
    process.exit(1);
  }
  return value;
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
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929",
  claudeWorkingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
  cliPath: process.env.CLAUDE_CLI_PATH || undefined,

  // Agent tuning
  maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || "10"),

  // Session
  sessionTimeoutHours: parseInt(process.env.SESSION_TIMEOUT_HOURS || "72"),
};
