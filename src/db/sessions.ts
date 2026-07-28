// src/db/sessions.ts
// ============================================================
// Session CRUD — Quản lý phiên hội thoại
// ============================================================

import { db } from "./connection.ts";
import { config } from "../config.ts";

export interface Session {
  userId: number;
  sessionId: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
  title: string;
}

export function getActiveSession(userId: number, project: string): Session | null {
  const row = db
    .query(
      `SELECT s.* FROM sessions s
       JOIN active_sessions a
         ON s.user_id = a.user_id AND s.session_id = a.session_id
       WHERE s.user_id = ? AND a.project = ?`,
    )
    .get(userId, project) as any;

  if (!row) return null;

  const hoursSinceActive = (Date.now() - row.last_active_at) / (1000 * 60 * 60);
  if (hoursSinceActive > config.sessionTimeoutHours) {
    clearActiveSession(userId, project);
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

export function createSession(
  userId: number,
  project: string,
  sessionId: string,
  title: string = "Phiên mới",
  model?: string,
): Session {
  const now = Date.now();
  const session: Session = {
    userId,
    sessionId,
    model: model || config.claudeModel,
    createdAt: now,
    lastActiveAt: now,
    title,
  };

  db.run(
    `INSERT OR REPLACE INTO sessions (user_id, session_id, model, created_at, last_active_at, title, project)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, sessionId, session.model, now, now, title, project],
  );

  db.run(
    `INSERT OR REPLACE INTO active_sessions (user_id, project, session_id) VALUES (?, ?, ?)`,
    [userId, project, sessionId],
  );

  return session;
}

export function touchSession(userId: number, sessionId: string): void {
  db.run(
    `UPDATE sessions SET last_active_at = ? WHERE user_id = ? AND session_id = ?`,
    [Date.now(), userId, sessionId],
  );
}

export function clearActiveSession(userId: number, project: string): void {
  // Phải lọc theo cả project — nếu chỉ lọc user_id, xoá active session của
  // project này sẽ xoá luôn phiên đang treo của MỌI project khác của user đó.
  db.run(`DELETE FROM active_sessions WHERE user_id = ? AND project = ?`, [userId, project]);
}

export function getRecentSessions(userId: number, project: string, limit = 5): Session[] {
  const rows = db
    .query(
      `SELECT * FROM sessions WHERE user_id = ? AND project = ?
       ORDER BY last_active_at DESC LIMIT ?`,
    )
    .all(userId, project, limit) as any[];

  return rows.map((row) => ({
    userId: row.user_id,
    sessionId: row.session_id,
    model: row.model,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    title: row.title,
  }));
}

export function setActiveSession(userId: number, project: string, sessionId: string): void {
  db.run(
    `INSERT OR REPLACE INTO active_sessions (user_id, project, session_id) VALUES (?, ?, ?)`,
    [userId, project, sessionId],
  );
  touchSession(userId, sessionId);
}
