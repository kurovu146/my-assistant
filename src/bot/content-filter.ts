// src/bot/content-filter.ts
// ============================================================
// Content Filter — Redact sensitive data trước khi gửi Telegram
// ============================================================
// Học từ: claude-code-templates/hooks/security/secret-scanner.py
//
// Scan response text, thay thế API keys, tokens, passwords...
// bằng [REDACTED] để tránh leak lên Telegram.
// ============================================================

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

// Các pattern phát hiện secrets — ưu tiên ít false positive
const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { name: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "AWS Secret Key", pattern: /\b[0-9a-zA-Z/+=]{40}\b(?=.*aws)/gi },

  // Anthropic
  { name: "Anthropic API Key", pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g },

  // OpenAI
  { name: "OpenAI API Key", pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g },

  // Google
  { name: "Google API Key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },

  // GitHub
  { name: "GitHub Token", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g },

  // Telegram Bot Token
  { name: "Telegram Bot Token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },

  // Stripe
  { name: "Stripe Key", pattern: /\b(sk|pk)_(live|test)_[A-Za-z0-9]{20,}\b/g },

  // Generic API key patterns (trong format KEY=value hoặc "key": "value")
  { name: "API Key Assignment", pattern: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?([a-zA-Z0-9_\-/.+=]{20,})["']?/gi },

  // Private keys
  { name: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g },

  // Database connection strings
  { name: "DB Connection String", pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"'`]+@[^\s"'`]+/g },

  // JWT tokens
  { name: "JWT Token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // Generic password assignments
  { name: "Password Assignment", pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']([^"'\s]{8,})["']/gi },
];

export interface FilterResult {
  text: string;
  redactedCount: number;
  redactedTypes: string[];
}

/**
 * Scan và redact sensitive data trong text.
 *
 * @returns FilterResult với text đã được redact và thống kê
 */
export function filterSensitiveContent(text: string): FilterResult {
  let filtered = text;
  const redactedTypes: string[] = [];
  let redactedCount = 0;

  for (const { name, pattern } of SECRET_PATTERNS) {
    // Reset regex lastIndex (vì dùng global flag)
    pattern.lastIndex = 0;
    const matches = filtered.match(pattern);

    if (matches && matches.length > 0) {
      redactedCount += matches.length;
      if (!redactedTypes.includes(name)) {
        redactedTypes.push(name);
      }
      filtered = filtered.replace(pattern, "[REDACTED]");
    }
  }

  return { text: filtered, redactedCount, redactedTypes };
}

/**
 * Filter text và thêm warning nếu có redact.
 * Dùng trực tiếp trước khi gửi Telegram message.
 */
export function sanitizeResponse(text: string): string {
  const result = filterSensitiveContent(text);

  if (result.redactedCount > 0) {
    const types = result.redactedTypes.join(", ");
    return `${result.text}\n\n⚠️ _${result.redactedCount} thông tin nhạy cảm đã được ẩn (${types})_`;
  }

  return result.text;
}
