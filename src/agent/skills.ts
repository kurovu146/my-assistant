// src/agent/skills.ts
// ============================================================
// Skills Loader — Đọc và gộp các file .md từ thư mục skills/
// ============================================================
//
// Upgrades (inspired by OpenClaw):
// - Progressive loading: load tên + description trước, full khi cần
// - Self-modifying: agent có thể tạo/sửa/xóa skill files
// - Hot-reload: fs.watch auto-clear cache khi skills thay đổi
// ============================================================

import { Glob } from "bun";
import { resolve, basename } from "path";
import { watch } from "fs";
import { logger } from "../logger.ts";

const SKILLS_DIR = resolve(import.meta.dir, "../../skills");

// --- Skill metadata (progressive loading) ---

export interface SkillMeta {
  name: string;
  title: string;       // Dòng đầu tiên (# Title)
  description: string;  // 2-3 dòng đầu sau title
  filePath: string;
  sizeBytes: number;
}

/**
 * Lấy metadata (tên + mô tả ngắn) của tất cả skills.
 * Dùng cho progressive loading — chỉ ~100 chars mỗi skill.
 */
export async function listSkillSummaries(): Promise<SkillMeta[]> {
  const summaries: SkillMeta[] = [];
  try {
    const glob = new Glob("*.md");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: SKILLS_DIR })) {
      files.push(file);
    }
    files.sort();

    for (const file of files) {
      const filePath = resolve(SKILLS_DIR, file);
      const content = await Bun.file(filePath).text();
      const name = basename(file, ".md");

      // Extract title (first # heading) and description (next 2-3 lines)
      const lines = content.split("\n").filter((l) => l.trim());
      const title = lines[0]?.replace(/^#+\s*/, "") || name;
      const desc = lines
        .slice(1, 4)
        .map((l) => l.replace(/^[#\-*>\s]+/, "").trim())
        .filter((l) => l.length > 0)
        .join("; ");

      summaries.push({
        name,
        title,
        description: desc.slice(0, 150),
        filePath,
        sizeBytes: content.length,
      });
    }
  } catch (error) {
    logger.warn("⚠️ Không đọc được thư mục skills/:", error);
  }
  return summaries;
}

// --- Full skill loading ---

/**
 * Đọc tất cả file .md trong thư mục skills/
 * Trả về nội dung gộp, mỗi file cách nhau bằng separator.
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
    logger.warn("⚠️ Không đọc được thư mục skills/:", error);
  }

  if (parts.length === 0) return "";

  return `\n\n---\n## Skills & Kiến thức chuyên môn\n\n${parts.join("\n\n---\n\n")}`;
}

// --- Self-modifying skills ---

/**
 * Tạo hoặc cập nhật skill file.
 * Agent gọi hàm này để tự tạo skill mới hoặc cập nhật skill hiện có.
 * Auto-clears system prompt cache → hot-reload lần gọi tiếp theo.
 */
export async function writeSkill(name: string, content: string): Promise<{ ok: boolean; message: string }> {
  // Validate name — chỉ cho phép a-z, 0-9, dash
  const safeName = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  if (!safeName || safeName.length < 2) {
    return { ok: false, message: "Tên skill không hợp lệ (cần ít nhất 2 ký tự a-z, 0-9, dash)" };
  }

  const filePath = resolve(SKILLS_DIR, `${safeName}.md`);
  const exists = await Bun.file(filePath).exists();

  try {
    await Bun.write(filePath, content.trim() + "\n");
    clearCache();
    const action = exists ? "updated" : "created";
    logger.log(`📝 Skill ${action}: ${safeName}.md`);
    return { ok: true, message: `Skill "${safeName}" đã ${exists ? "cập nhật" : "tạo mới"}` };
  } catch (error) {
    return { ok: false, message: `Lỗi ghi skill: ${error instanceof Error ? error.message : error}` };
  }
}

/**
 * Xóa skill file.
 */
export async function deleteSkill(name: string): Promise<{ ok: boolean; message: string }> {
  const safeName = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const filePath = resolve(SKILLS_DIR, `${safeName}.md`);

  try {
    const exists = await Bun.file(filePath).exists();
    if (!exists) {
      return { ok: false, message: `Skill "${safeName}" không tồn tại` };
    }
    const fs = await import("fs/promises");
    await fs.unlink(filePath);
    clearCache();
    logger.log(`🗑 Skill deleted: ${safeName}.md`);
    return { ok: true, message: `Skill "${safeName}" đã xóa` };
  } catch (error) {
    return { ok: false, message: `Lỗi xóa skill: ${error instanceof Error ? error.message : error}` };
  }
}

// --- Cache management ---

let cachedSkillCount = 0;

export function getSkillCount(): number {
  return cachedSkillCount;
}

// External cache reference — set by claude.ts via setOnCacheClear()
let onCacheClear: (() => void) | null = null;

export function setOnCacheClear(callback: () => void): void {
  onCacheClear = callback;
}

function clearCache(): void {
  cachedSkillCount = 0;
  onCacheClear?.();
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
    logger.warn("⚠️ Không tìm thấy CLAUDE.md");
  }

  const skills = await loadSkills();

  const fullPrompt = (basePrompt.trim() + skills).trim();

  if (fullPrompt) {
    cachedSkillCount = skills ? skills.split("<!-- skill:").length - 1 : 0;
    logger.log(`📚 System prompt loaded (${cachedSkillCount} skills)`);
  }

  return fullPrompt;
}

// --- Hot-reload watcher ---

let watcher: ReturnType<typeof watch> | null = null;

/**
 * Start watching skills directory for changes.
 * Auto-clears cache khi files thay đổi → reload lần gọi tiếp theo.
 */
export function startSkillWatcher(): void {
  if (watcher) return;

  try {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    watcher = watch(SKILLS_DIR, (eventType, filename) => {
      if (!filename?.endsWith(".md")) return;

      // Debounce 500ms — tránh reload nhiều lần khi save nhanh
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.log(`🔄 Skill file changed: ${filename} — auto-reloading`);
        clearCache();
      }, 500);
    });

    logger.log("👁 Skills watcher started");
  } catch (error) {
    logger.warn("⚠️ Cannot watch skills directory:", error);
  }
}

export function stopSkillWatcher(): void {
  watcher?.close();
  watcher = null;
}
