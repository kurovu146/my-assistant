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

// Bảng query_logs: log mỗi query để analytics
db.run(`
  CREATE TABLE IF NOT EXISTS query_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    prompt_preview TEXT NOT NULL,
    response_time_ms INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    tools_used TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )
`);

// Indexes cho query_logs — tăng tốc /status analytics
db.run(`CREATE INDEX IF NOT EXISTS idx_query_logs_user ON query_logs (user_id, created_at)`);

// Bảng monitored_urls: URLs đang được theo dõi
db.run(`
  CREATE TABLE IF NOT EXISTS monitored_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    last_hash TEXT,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER
  )
`);

// --- Monitored URL Operations ---

export interface MonitoredUrl {
  id: number;
  userId: number;
  url: string;
  label: string;
  lastHash: string | null;
  createdAt: number;
  lastCheckedAt: number | null;
}

/**
 * Thêm URL để monitor.
 */
export function addMonitoredUrl(userId: number, url: string, label: string): MonitoredUrl {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO monitored_urls (user_id, url, label, created_at) VALUES (?, ?, ?, ?)`,
    [userId, url, label, now],
  );
  return {
    id: Number(result.lastInsertRowid),
    userId,
    url,
    label,
    lastHash: null,
    createdAt: now,
    lastCheckedAt: null,
  };
}

/**
 * Xóa URL khỏi monitor.
 */
export function removeMonitoredUrl(userId: number, url: string): boolean {
  const result = db.run(
    `DELETE FROM monitored_urls WHERE user_id = ? AND url = ?`,
    [userId, url],
  );
  return result.changes > 0;
}

/**
 * Lấy danh sách URLs đang monitor (tất cả users).
 */
export function getMonitoredUrls(): MonitoredUrl[] {
  const rows = db.query(`SELECT * FROM monitored_urls`).all() as any[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    url: r.url,
    label: r.label,
    lastHash: r.last_hash,
    createdAt: r.created_at,
    lastCheckedAt: r.last_checked_at,
  }));
}

/**
 * Lấy URLs đang monitor của 1 user.
 */
export function getUserMonitoredUrls(userId: number): MonitoredUrl[] {
  const rows = db
    .query(`SELECT * FROM monitored_urls WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as any[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    url: r.url,
    label: r.label,
    lastHash: r.last_hash,
    createdAt: r.created_at,
    lastCheckedAt: r.last_checked_at,
  }));
}

/**
 * Cập nhật hash sau khi check.
 */
export function updateUrlHash(id: number, hash: string): void {
  db.run(
    `UPDATE monitored_urls SET last_hash = ?, last_checked_at = ? WHERE id = ?`,
    [hash, Date.now(), id],
  );
}

// --- Query Log Operations ---

export interface QueryLog {
  promptPreview: string;
  responseTimeMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolsUsed: string;
  createdAt: number;
}

/**
 * Log một query đã hoàn thành.
 */
export function logQuery(
  userId: number,
  promptPreview: string,
  responseTimeMs: number,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  toolsUsed: string[],
): void {
  db.run(
    `INSERT INTO query_logs (user_id, prompt_preview, response_time_ms, tokens_in, tokens_out, cost_usd, tools_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      promptPreview.slice(0, 50),
      responseTimeMs,
      tokensIn,
      tokensOut,
      costUsd,
      toolsUsed.join(","),
      Date.now(),
    ],
  );
}

export interface QueryStats {
  totalQueries: number;
  todayQueries: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgResponseMs: number;
  topTools: { name: string; count: number }[];
}

/**
 * Lấy thống kê query cho user.
 */
export function getQueryStats(userId: number): QueryStats {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const total = db
    .query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(tokens_in), 0) as tin, COALESCE(SUM(tokens_out), 0) as tout,
              COALESCE(SUM(cost_usd), 0) as cost, COALESCE(AVG(response_time_ms), 0) as avg_ms
       FROM query_logs WHERE user_id = ?`,
    )
    .get(userId) as any;

  const today = db
    .query(
      `SELECT COUNT(*) as cnt FROM query_logs WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, todayStart.getTime()) as any;

  // Top tools — parse comma-separated tools_used
  const allTools = db
    .query(`SELECT tools_used FROM query_logs WHERE user_id = ? AND tools_used != ''`)
    .all(userId) as any[];

  const toolCounts = new Map<string, number>();
  for (const row of allTools) {
    for (const tool of row.tools_used.split(",")) {
      const t = tool.trim();
      if (t) toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
    }
  }

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    totalQueries: total.cnt,
    todayQueries: today.cnt,
    totalTokensIn: total.tin,
    totalTokensOut: total.tout,
    totalCostUsd: total.cost,
    avgResponseMs: Math.round(total.avg_ms),
    topTools,
  };
}

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
