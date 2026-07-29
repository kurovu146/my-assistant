// src/claude/system-prompt.ts
// ============================================================
// System prompt — persona của bot, đọc từ CLAUDE.md
// ============================================================
//
// File này từng là `skills.ts`: ngoài CLAUDE.md nó còn gộp mọi file .md trong
// `skills/` vào system prompt, kèm watcher hot-reload và bộ tool cho agent tự
// ghi/xoá skill. Bỏ hết ngày 2026-07-29 — agent chưa lần nào đọc một file trong
// đó, trong khi gọi tool `Skill` của Claude Code 9 lần. Skill giờ đặt ở
// `~/.claude/skills/` (dùng khắp nơi) hoặc `<project>/.claude/skills/` (riêng
// từng project), agent tự khám phá qua `description` trong frontmatter.
// ============================================================

import { resolve } from "path";
import { logger } from "../logger.ts";

const CLAUDE_MD_PATH = resolve(import.meta.dir, "../../CLAUDE.md");

/**
 * Đọc CLAUDE.md làm phần nối thêm vào system prompt preset của Claude Code.
 *
 * Thiếu file thì trả chuỗi rỗng chứ không ném: bot mất persona vẫn chạy được,
 * còn hơn chết hẳn vì một file tài liệu.
 */
export async function buildSystemPrompt(): Promise<string> {
  try {
    const content = (await Bun.file(CLAUDE_MD_PATH).text()).trim();
    logger.log(`📄 System prompt loaded (${content.length} chars từ CLAUDE.md)`);
    return content;
  } catch {
    logger.warn("⚠️ Không tìm thấy CLAUDE.md — bot chạy không có persona");
    return "";
  }
}
