// src/db/projects.ts
// ============================================================
// Project registry — mỗi project một phiên và một thư mục riêng
// ============================================================

import { existsSync } from "fs";
import { join } from "path";
import { config } from "../config.ts";

const NAME_PATTERN = /^[a-z0-9._-]{1,64}$/;

/**
 * Chuẩn hoá tên project, trả null nếu không hợp lệ.
 *
 * Tên này ghép thẳng vào đường dẫn cwd của agent, nên "..", "/" và ký tự lạ
 * phải bị chặn — nếu không `/p ../../etc` sẽ cho agent chạy ngoài ~/dev.
 */
export function normalizeProjectName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) return null;
  if (name === "." || name === "..") return null;
  return name;
}

/** Thư mục của project; không tồn tại thì lùi về thư mục gốc. */
export function resolveProjectPath(name: string): { path: string; exists: boolean } {
  const candidate = join(config.claudeWorkingDir, name);
  return existsSync(candidate)
    ? { path: candidate, exists: true }
    : { path: config.claudeWorkingDir, exists: false };
}
