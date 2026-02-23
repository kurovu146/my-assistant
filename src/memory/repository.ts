// src/memory/repository.ts
// ============================================================
// Memory Fact Repository — CRUD + FTS5 search
// ============================================================

import { db } from "../db/connection.ts";

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

export function saveFact(userId: number, fact: string, category: string = "general", source: string = ""): MemoryFact {
  const now = Date.now();

  const existing = db
    .query(`SELECT id FROM memory_facts WHERE user_id = ? AND fact = ?`)
    .get(userId, fact) as any;

  if (existing) {
    db.run(
      `UPDATE memory_facts SET category = ?, source = ?, updated_at = ? WHERE id = ?`,
      [category, source, now, existing.id],
    );
    return { id: existing.id, userId, fact, category, source, createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0 };
  }

  const result = db.run(
    `INSERT INTO memory_facts (user_id, fact, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, fact, category, source, now, now],
  );
  return {
    id: Number(result.lastInsertRowid),
    userId, fact, category, source,
    createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0,
  };
}

export function searchFacts(userId: number, keyword: string, limit: number = 20): MemoryFact[] {
  // FTS5 search
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
    const matchedFacts = ftsRows.map(mapFact);
    touchFactsAccess(matchedFacts.map((f) => f.id));
    return enrichWithContext(userId, matchedFacts, limit);
  }

  // LIKE fallback
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

function enrichWithContext(userId: number, matchedFacts: MemoryFact[], limit: number): MemoryFact[] {
  const matchedIds = new Set(matchedFacts.map((f) => f.id));
  const enriched: MemoryFact[] = [...matchedFacts];

  const ONE_HOUR = 60 * 60 * 1000;
  for (const fact of matchedFacts) {
    const neighbors = db
      .query(
        `SELECT * FROM memory_facts
         WHERE user_id = ? AND category = ? AND id != ?
           AND created_at BETWEEN ? AND ?
         ORDER BY ABS(created_at - ?) ASC
         LIMIT 2`,
      )
      .all(userId, fact.category, fact.id, fact.createdAt - ONE_HOUR, fact.createdAt + ONE_HOUR, fact.createdAt) as any[];

    for (const n of neighbors) {
      if (!matchedIds.has(n.id)) {
        matchedIds.add(n.id);
        enriched.push(mapFact(n));
      }
    }
  }

  return enriched.slice(0, limit);
}

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

function touchFactsAccess(factIds: number[]): void {
  if (factIds.length === 0) return;
  const placeholders = factIds.map(() => "?").join(",");
  db.run(
    `UPDATE memory_facts SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id IN (${placeholders})`,
    [Date.now(), ...factIds],
  );
}

export function getFactsByCategory(userId: number, category: string): MemoryFact[] {
  const rows = db
    .query(`SELECT * FROM memory_facts WHERE user_id = ? AND category = ? ORDER BY updated_at DESC`)
    .all(userId, category) as any[];
  return rows.map(mapFact);
}

export function deleteFact(userId: number, factId: number): boolean {
  const result = db.run(
    `DELETE FROM memory_facts WHERE id = ? AND user_id = ?`,
    [factId, userId],
  );
  return result.changes > 0;
}

export function countFacts(userId: number): number {
  const row = db.query(`SELECT COUNT(*) as cnt FROM memory_facts WHERE user_id = ?`).get(userId) as any;
  return row.cnt;
}

function mapFact(r: any): MemoryFact {
  return {
    id: r.id, userId: r.user_id, fact: r.fact, category: r.category,
    source: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at || 0, accessCount: r.access_count || 0,
  };
}

// Cleanup operations
export interface CleanupResult {
  logsDeleted: number;
  sessionsDeleted: number;
}

export function cleanupOldData(): CleanupResult {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const logsResult = db.run(`DELETE FROM query_logs WHERE created_at < ?`, [ninetyDaysAgo]);
  const sessionsResult = db.run(
    `DELETE FROM sessions
     WHERE last_active_at < ?
       AND (user_id, session_id) NOT IN (
         SELECT user_id, session_id FROM active_sessions
       )`,
    [thirtyDaysAgo],
  );

  return { logsDeleted: logsResult.changes, sessionsDeleted: sessionsResult.changes };
}
