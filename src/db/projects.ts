// src/db/projects.ts
// ============================================================
// Project registry — mỗi project một phiên và một thư mục riêng
// ============================================================

import { statSync } from "fs";
import { join } from "path";
import { config } from "../config.ts";
import { db } from "./connection.ts";

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

/**
 * Thư mục của project có còn tồn tại trên đĩa không.
 *
 * Dùng để cảnh báo trong danh sách `/p` khi thư mục bị xoá SAU khi project đã
 * đăng ký — nếu không, agent sẽ âm thầm chạy trong thư mục gốc ở mọi tin nhắn
 * mà không ai biết, vì cảnh báo lúc chọn project chỉ hiện đúng lúc gõ `/p <tên>`,
 * không hiện lại khi chỉ xem danh sách (finding từ review Task 5).
 */
export function projectDirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- Project registry CRUD ---

export interface Project {
  name: string;
  path: string;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * Tạo project nếu chưa có. Trả null khi tên không hợp lệ.
 *
 * `baseDir` mặc định là `config.claudeWorkingDir`, giống `resolveProjectPath` —
 * tham số này tồn tại để test trỏ vào thư mục tạm thay vì phụ thuộc `~/dev` thật.
 */
export function ensureProject(
  rawName: string,
  baseDir: string = config.claudeWorkingDir,
): { project: Project; created: boolean } | null {
  const name = normalizeProjectName(rawName);
  if (!name) return null;

  const now = Date.now();
  const existing = db.query(`SELECT * FROM projects WHERE name = ?`).get(name) as any;

  if (existing) {
    // Lần đăng ký đầu có thể xảy ra trước khi thư mục thật được tạo (path khi
    // đó là fallback về baseDir) — phân giải lại mỗi lần dùng để registry theo
    // kịp, tránh kẹt với đường dẫn cũ đã sai lệch với thực tế trên đĩa.
    const { path } = resolveProjectPath(name, baseDir);
    if (path !== existing.path) {
      db.run(`UPDATE projects SET path = ?, last_used_at = ? WHERE name = ?`, [path, now, name]);
    } else {
      db.run(`UPDATE projects SET last_used_at = ? WHERE name = ?`, [now, name]);
    }
    return {
      project: { name, path, createdAt: existing.created_at, lastUsedAt: now },
      created: false,
    };
  }

  const { path } = resolveProjectPath(name, baseDir);
  db.run(`INSERT INTO projects (name, path, created_at, last_used_at) VALUES (?, ?, ?, ?)`, [
    name,
    path,
    now,
    now,
  ]);
  return { project: { name, path, createdAt: now, lastUsedAt: now }, created: true };
}

export function listProjects(): (Project & { sessionCount: number })[] {
  const rows = db
    .query(
      `SELECT p.*, (SELECT COUNT(*) FROM sessions s WHERE s.project = p.name) AS session_count
       FROM projects p ORDER BY p.last_used_at DESC`,
    )
    .all() as any[];

  return rows.map((r) => ({
    name: r.name,
    path: r.path,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    sessionCount: r.session_count,
  }));
}

/** Chuỗi rỗng nghĩa là chưa chọn project — dùng thư mục gốc như trước đây. */
export function getCurrentProject(userId: number): string {
  const row = db.query(`SELECT project FROM current_project WHERE user_id = ?`).get(userId) as
    | { project: string }
    | undefined;
  if (!row) return "";

  // Project bị xoá khỏi bảng projects mà con trỏ còn sót → coi như chưa chọn
  const exists = db.query(`SELECT 1 FROM projects WHERE name = ?`).get(row.project);
  return exists ? row.project : "";
}

export function setCurrentProject(userId: number, name: string): void {
  db.run(
    `INSERT INTO current_project (user_id, project) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET project = excluded.project`,
    [userId, name],
  );
}
