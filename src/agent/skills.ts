// src/agent/skills.ts
// ============================================================
// Skills Loader — Đọc và gộp các file .md từ thư mục skills/
// ============================================================
//
// Mỗi file .md trong skills/ là 1 "skill" — kiến thức chuyên môn
// mà agent sẽ dùng khi trả lời.
//
// Flow:
//   Bot khởi động → loadSkills() đọc tất cả *.md
//   → Gộp thành 1 string → Truyền vào systemPrompt
//
// Thêm skill mới: tạo file .md trong skills/, restart bot.
// ============================================================

import { Glob } from "bun";
import { resolve, basename } from "path";

const SKILLS_DIR = resolve(import.meta.dir, "../../skills");

/**
 * Đọc tất cả file .md trong thư mục skills/
 * Trả về nội dung gộp, mỗi file cách nhau bằng separator.
 *
 * @returns string — Nội dung tất cả skills, rỗng nếu không có file nào
 */
export async function loadSkills(): Promise<string> {
  const parts: string[] = [];

  try {
    const glob = new Glob("*.md");
    const files: string[] = [];

    for await (const file of glob.scan({ cwd: SKILLS_DIR })) {
      files.push(file);
    }

    // Sắp xếp theo tên để thứ tự ổn định
    files.sort();

    for (const file of files) {
      const filePath = resolve(SKILLS_DIR, file);
      const content = await Bun.file(filePath).text();
      const skillName = basename(file, ".md");

      parts.push(`<!-- skill: ${skillName} -->\n${content.trim()}`);
    }
  } catch (error) {
    console.warn("⚠️ Không đọc được thư mục skills/:", error);
  }

  if (parts.length === 0) return "";

  return `\n\n---\n## Skills & Kiến thức chuyên môn\n\n${parts.join("\n\n---\n\n")}`;
}

// Cache skill count — cập nhật khi buildSystemPrompt() chạy
let cachedSkillCount = 0;

/**
 * Lấy số lượng skills đã load (từ cache, không đọc disk).
 * Dùng trong /status để tránh I/O không cần thiết.
 */
export function getSkillCount(): number {
  return cachedSkillCount;
}

/**
 * Đọc CLAUDE.md (system instructions) + gộp skills
 * Trả về systemPrompt hoàn chỉnh.
 */
export async function buildSystemPrompt(): Promise<string> {
  const claudeMdPath = resolve(import.meta.dir, "../../CLAUDE.md");

  let basePrompt = "";
  try {
    basePrompt = await Bun.file(claudeMdPath).text();
  } catch {
    console.warn("⚠️ Không tìm thấy CLAUDE.md");
  }

  const skills = await loadSkills();

  const fullPrompt = (basePrompt.trim() + skills).trim();

  if (fullPrompt) {
    cachedSkillCount = skills ? skills.split("<!-- skill:").length - 1 : 0;
    console.log(`📚 System prompt loaded (${cachedSkillCount} skills)`);
  }

  return fullPrompt;
}
