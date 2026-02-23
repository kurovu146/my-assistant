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

export function getActiveSession(userId: number): Session | null {
  const row = db
    .query(
      `SELECT s.* FROM sessions s
       JOIN active_sessions a ON s.user_id = a.user_id AND s.session_id = a.session_id
       WHERE s.user_id = ?`,
    )
    .get(userId) as any;

  if (!row) return null;

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

export function createSession(
  userId: number,
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
    `INSERT OR REPLACE INTO sessions (user_id, session_id, model, created_at, last_active_at, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, sessionId, session.model, now, now, title],
  );

  db.run(
    `INSERT OR REPLACE INTO active_sessions (user_id, session_id) VALUES (?, ?)`,
    [userId, sessionId],
  );

  return session;
}

export function touchSession(userId: number, sessionId: string): void {
  db.run(
    `UPDATE sessions SET last_active_at = ? WHERE user_id = ? AND session_id = ?`,
    [Date.now(), userId, sessionId],
  );
}

export function clearActiveSession(userId: number): void {
  db.run(`DELETE FROM active_sessions WHERE user_id = ?`, [userId]);
}

export function getRecentSessions(userId: number, limit = 5): Session[] {
  const rows = db
    .query(
      `SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC LIMIT ?`,
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

export function setActiveSession(userId: number, sessionId: string): void {
  db.run(
    `INSERT OR REPLACE INTO active_sessions (user_id, session_id) VALUES (?, ?)`,
    [userId, sessionId],
  );
  touchSession(userId, sessionId);
}
