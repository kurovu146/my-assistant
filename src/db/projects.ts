// src/db/projects.ts
// ============================================================
// Project registry — mỗi project một phiên và một thư mục riêng
// ============================================================

import { statSync } from "fs";
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

/**
 * Thư mục của project; không tồn tại (hoặc không phải thư mục) thì lùi về thư mục gốc.
 *
 * Nhận thẳng input thô (vd. text từ Telegram) — tự chuẩn hoá bên trong bằng
 * `normalizeProjectName` thay vì bắt caller nhớ gọi trước, vì chỉ cần một chỗ
 * gọi quên là có path traversal thật (cho agent chạy Bash ngoài ~/dev).
 *
 * `baseDir` mặc định là `config.claudeWorkingDir`; tham số này tồn tại để test
 * có thể trỏ vào một thư mục tạm thay vì phụ thuộc filesystem/`.env` thật.
 */
export function resolveProjectPath(
  raw: string,
  baseDir: string = config.claudeWorkingDir,
): { path: string; exists: boolean } {
  const name = normalizeProjectName(raw);
  if (name === null) return { path: baseDir, exists: false };

  const candidate = join(baseDir, name);
  try {
    // existsSync không phân biệt file với thư mục — `/p package.json` từng
    // cho exists:true rồi Task 5 đặt cwd của agent trỏ vào một file, agent hỏng
    // ngay lúc khởi động. Chỉ coi là tồn tại khi thực sự là thư mục.
    return statSync(candidate).isDirectory()
      ? { path: candidate, exists: true }
      : { path: baseDir, exists: false };
  } catch {
    // Không tồn tại hoặc không có quyền đọc — coi như chưa có project.
    return { path: baseDir, exists: false };
  }
}
