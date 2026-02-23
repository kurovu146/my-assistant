// src/db/monitors.ts
// ============================================================
// Monitor URL CRUD — Web change detection
// ============================================================

import { db } from "./connection.ts";

export interface MonitoredUrl {
  id: number;
  userId: number;
  url: string;
  label: string;
  lastHash: string | null;
  createdAt: number;
  lastCheckedAt: number | null;
}

export function addMonitoredUrl(userId: number, url: string, label: string): MonitoredUrl {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO monitored_urls (user_id, url, label, created_at) VALUES (?, ?, ?, ?)`,
    [userId, url, label, now],
  );
  return {
    id: Number(result.lastInsertRowid),
    userId, url, label,
    lastHash: null, createdAt: now, lastCheckedAt: null,
  };
}

export function removeMonitoredUrl(userId: number, url: string): boolean {
  const result = db.run(
    `DELETE FROM monitored_urls WHERE user_id = ? AND url = ?`,
    [userId, url],
  );
  return result.changes > 0;
}

export function getMonitoredUrls(): MonitoredUrl[] {
  const rows = db.query(`SELECT * FROM monitored_urls`).all() as any[];
  return rows.map(mapUrl);
}

export function getUserMonitoredUrls(userId: number): MonitoredUrl[] {
  const rows = db
    .query(`SELECT * FROM monitored_urls WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as any[];
  return rows.map(mapUrl);
}

export function updateUrlHash(id: number, hash: string): void {
  db.run(
    `UPDATE monitored_urls SET last_hash = ?, last_checked_at = ? WHERE id = ?`,
    [hash, Date.now(), id],
  );
}

function mapUrl(r: any): MonitoredUrl {
  return {
    id: r.id, userId: r.user_id, url: r.url, label: r.label,
    lastHash: r.last_hash, createdAt: r.created_at, lastCheckedAt: r.last_checked_at,
  };
}
