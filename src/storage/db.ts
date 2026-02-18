// src/storage/db.ts
// ============================================================
// Session Manager — Quản lý phiên hội thoại bằng SQLite
// ============================================================
// Tại sao cần session?
// → Khi bạn nhắn nhiều tin, Claude cần biết các tin nhắn
//   trước đó để trả lời đúng ngữ cảnh.
// → Claude Agent SDK có session_id, mình lưu lại để resume.
//
// Bun có SQLite built-in, không cần cài thêm package.
// Data lưu trong file sessions.db ngay thư mục project.
// ============================================================

import { Database } from "bun:sqlite";
import { resolve } from "path";
import { config } from "../config.ts";

// --- Types ---

export interface Session {
  userId: number; // Telegram user ID
  sessionId: string; // Claude Agent SDK session ID
  model: string; // Model đang dùng
  createdAt: number; // Unix timestamp tạo phiên
  lastActiveAt: number; // Lần cuối nhắn tin
  title: string; // Mô tả ngắn (lấy từ tin nhắn đầu tiên)
}

// --- Database Setup ---

const DB_PATH = resolve(import.meta.dir, "../../sessions.db");
const db = new Database(DB_PATH);

// Bảng sessions: lưu tất cả phiên hội thoại
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5-20250929',
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT 'Phiên mới',
    PRIMARY KEY (user_id, session_id)
  )
`);

// Bảng active_sessions: mỗi user chỉ có 1 phiên đang active
// → Khi user nhắn tin, bot biết ngay nên dùng session nào
db.run(`
  CREATE TABLE IF NOT EXISTS active_sessions (
    user_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL
  )
`);

// --- Session Operations ---

/**
 * Lấy session đang active của user.
 * Trả về null nếu chưa có hoặc đã hết hạn (quá 24h không dùng).
 */
export function getActiveSession(userId: number): Session | null {
  const row = db
    .query(
      `SELECT s.* FROM sessions s
       JOIN active_sessions a ON s.user_id = a.user_id AND s.session_id = a.session_id
       WHERE s.user_id = ?`,
    )
    .get(userId) as any;

  if (!row) return null;

  // Kiểm tra timeout — quá 24h không dùng thì coi như hết phiên
  const hoursSinceActive = (Date.now() - row.last_active_at) / (1000 * 60 * 60);
  if (hoursSinceActive > config.sessionTimeoutHours) {
    clearActiveSession(userId);
    return null;
  }

  return {
    userId: row.user_id,
    sessionId: row.session_id,
    model: row.model,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    title: row.title,
  };
}

/**
 * Tạo session mới và đặt làm active.
 * Gọi khi user nhắn tin lần đầu hoặc sau /new.
 */
export function createSession(
  userId: number,
  sessionId: string,
  title: string = "Phiên mới",
): Session {
  const now = Date.now();
  const session: Session = {
    userId,
    sessionId,
    model: config.claudeModel,
    createdAt: now,
    lastActiveAt: now,
    title,
  };

  // Lưu vào bảng sessions
  db.run(
    `INSERT OR REPLACE INTO sessions (user_id, session_id, model, created_at, last_active_at, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, sessionId, session.model, now, now, title],
  );

  // Đặt làm active session
  db.run(
    `INSERT OR REPLACE INTO active_sessions (user_id, session_id) VALUES (?, ?)`,
    [userId, sessionId],
  );

  return session;
}

/**
 * Cập nhật thời gian hoạt động.
 * Gọi mỗi lần user nhắn tin để reset timeout 24h.
 */
export function touchSession(userId: number, sessionId: string): void {
  db.run(
    `UPDATE sessions SET last_active_at = ? WHERE user_id = ? AND session_id = ?`,
    [Date.now(), userId, sessionId],
  );
}

/**
 * Cập nhật title cho session.
 * Dùng tin nhắn đầu tiên làm title để dễ nhận diện khi /resume.
 */
export function updateSessionTitle(
  userId: number,
  sessionId: string,
  title: string,
): void {
  db.run(`UPDATE sessions SET title = ? WHERE user_id = ? AND session_id = ?`, [
    title,
    userId,
    sessionId,
  ]);
}

/**
 * Xóa active session.
 * Gọi khi user gõ /new — session cũ vẫn còn, chỉ không active nữa.
 */
export function clearActiveSession(userId: number): void {
  db.run(`DELETE FROM active_sessions WHERE user_id = ?`, [userId]);
}

/**
 * Lấy danh sách sessions gần đây (cho /resume).
 * User có thể chọn phiên cũ để tiếp tục.
 */
export function getRecentSessions(userId: number, limit = 5): Session[] {
  const rows = db
    .query(
      `SELECT * FROM sessions
       WHERE user_id = ?
       ORDER BY last_active_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as any[];

  return rows.map((row) => ({
    userId: row.user_id,
    sessionId: row.session_id,
    model: row.model,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    title: row.title,
  }));
}

/**
 * Đặt một session cũ làm active (cho /resume).
 * User chọn phiên từ danh sách → bot chuyển sang phiên đó.
 */
export function setActiveSession(userId: number, sessionId: string): void {
  db.run(
    `INSERT OR REPLACE INTO active_sessions (user_id, session_id) VALUES (?, ?)`,
    [userId, sessionId],
  );
  touchSession(userId, sessionId);
}
