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

// Bảng memory_facts: lưu facts extracted từ conversations
db.run(`
  CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fact TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_memory_facts_user ON memory_facts (user_id, category)`);

// Migrate: thêm cột last_accessed_at, access_count nếu chưa có
try {
  db.run(`ALTER TABLE memory_facts ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists */ }
try {
  db.run(`ALTER TABLE memory_facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists */ }

// FTS5 virtual table cho full-text search trên facts
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
    fact, category,
    content='memory_facts',
    content_rowid='id'
  )
`);

// Triggers tự đồng bộ FTS5 khi INSERT/UPDATE/DELETE
db.run(`
  CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(rowid, fact, category)
    VALUES (new.id, new.fact, new.category);
  END
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, category)
    VALUES ('delete', old.id, old.fact, old.category);
  END
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, category)
    VALUES ('delete', old.id, old.fact, old.category);
    INSERT INTO memory_facts_fts(rowid, fact, category)
    VALUES (new.id, new.fact, new.category);
  END
`);

// Rebuild FTS5 index — đồng bộ data cũ (chạy 1 lần, nhanh với vài trăm rows)
db.run(`INSERT OR IGNORE INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')`);

// --- Memory Operations ---

export interface MemoryFact {
  id: number;
  userId: number;
  fact: string;
  category: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

/**
 * Lưu fact mới vào memory.
 */
export function saveFact(userId: number, fact: string, category: string = "general", source: string = ""): MemoryFact {
  const now = Date.now();

  // Check duplicate — nếu đã có fact tương tự thì update thay vì insert
  const existing = db
    .query(`SELECT id FROM memory_facts WHERE user_id = ? AND fact = ?`)
    .get(userId, fact) as any;

  if (existing) {
    db.run(
      `UPDATE memory_facts SET category = ?, source = ?, updated_at = ? WHERE id = ?`,
      [category, source, now, existing.id],
    );
    return { id: existing.id, userId, fact, category, source, createdAt: now, updatedAt: now };
  }

  const result = db.run(
    `INSERT INTO memory_facts (user_id, fact, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, fact, category, source, now, now],
  );
  return {
    id: Number(result.lastInsertRowid),
    userId,
    fact,
    category,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Tìm facts theo keyword — hybrid FTS5 + LIKE fallback.
 * FTS5 cho ranked results tốt hơn, LIKE fallback nếu FTS5 trả rỗng.
 */
export function searchFacts(userId: number, keyword: string, limit: number = 20): MemoryFact[] {
  // FTS5 search trước — ranked by relevance (bm25)
  const ftsRows = db
    .query(
      `SELECT m.*, bm25(memory_facts_fts) as rank
       FROM memory_facts_fts fts
       JOIN memory_facts m ON m.id = fts.rowid
       WHERE memory_facts_fts MATCH ? AND m.user_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(keyword, userId, limit) as any[];

  if (ftsRows.length > 0) {
    touchFactsAccess(ftsRows.map((r: any) => r.id));
    return ftsRows.map(mapFact);
  }

  // LIKE fallback — cho trường hợp keyword không match FTS syntax
  const likeRows = db
    .query(
      `SELECT * FROM memory_facts WHERE user_id = ? AND (fact LIKE ? OR category LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, `%${keyword}%`, `%${keyword}%`, limit) as any[];

  if (likeRows.length > 0) {
    touchFactsAccess(likeRows.map((r: any) => r.id));
  }
  return likeRows.map(mapFact);
}

/**
 * Lấy facts của user, ưu tiên: hay truy cập + mới update.
 * Dùng composite score: recency + frequency.
 */
export function getUserFacts(userId: number, limit: number = 50): MemoryFact[] {
  const rows = db
    .query(
      `SELECT * FROM memory_facts WHERE user_id = ?
       ORDER BY
         CASE WHEN access_count > 0 THEN 1 ELSE 0 END DESC,
         updated_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as any[];
  return rows.map(mapFact);
}

/**
 * Cập nhật last_accessed_at + access_count cho facts đã truy cập.
 */
function touchFactsAccess(factIds: number[]): void {
  if (factIds.length === 0) return;
  const placeholders = factIds.map(() => "?").join(",");
  db.run(
    `UPDATE memory_facts SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id IN (${placeholders})`,
    [Date.now(), ...factIds],
  );
}

/**
 * Lấy facts theo category.
 */
export function getFactsByCategory(userId: number, category: string): MemoryFact[] {
  const rows = db
    .query(`SELECT * FROM memory_facts WHERE user_id = ? AND category = ? ORDER BY updated_at DESC`)
    .all(userId, category) as any[];
  return rows.map(mapFact);
}

/**
 * Xóa fact theo ID.
 */
export function deleteFact(userId: number, factId: number): boolean {
  const result = db.run(
    `DELETE FROM memory_facts WHERE id = ? AND user_id = ?`,
    [factId, userId],
  );
  return result.changes > 0;
}

/**
 * Đếm tổng facts của user.
 */
export function countFacts(userId: number): number {
  const row = db.query(`SELECT COUNT(*) as cnt FROM memory_facts WHERE user_id = ?`).get(userId) as any;
  return row.cnt;
}

function mapFact(r: any): MemoryFact {
  return {
    id: r.id,
    userId: r.user_id,
    fact: r.fact,
    category: r.category,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at || 0,
    accessCount: r.access_count || 0,
  };
}

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
