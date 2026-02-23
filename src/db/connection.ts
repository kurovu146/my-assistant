// src/db/connection.ts
// ============================================================
// Database Connection — SQLite init + migrations
// ============================================================

import { Database } from "bun:sqlite";
import { resolve } from "path";

const DB_PATH = resolve(import.meta.dir, "../../sessions.db");
export const db = new Database(DB_PATH);

// --- Schema ---

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT 'Phiên mới',
    PRIMARY KEY (user_id, session_id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS active_sessions (
    user_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL
  )
`);

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
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_query_logs_user ON query_logs (user_id, created_at)`);

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

// --- Migrations ---

try {
  db.run(`ALTER TABLE memory_facts ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists */ }
try {
  db.run(`ALTER TABLE memory_facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists */ }
try {
  db.run(`ALTER TABLE query_logs ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
} catch (_) { /* column already exists */ }

// --- FTS5 ---

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
    fact, category,
    content='memory_facts',
    content_rowid='id'
  )
`);

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

db.run(`INSERT OR IGNORE INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')`);
