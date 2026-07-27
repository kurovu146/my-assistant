// src/db/connection.ts
// ============================================================
// Database Connection — SQLite init + migrations
// ============================================================

import { Database } from "bun:sqlite";
import { resolve } from "path";

// SESSIONS_DB_PATH cho phép test chạy trên DB riêng (":memory:")
const DB_PATH = process.env.SESSIONS_DB_PATH || resolve(import.meta.dir, "../../sessions.db");
export const db = new Database(DB_PATH);

// Bot handler và scheduler cùng ghi → WAL + chờ khi bị khóa
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

// --- Schema ---

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'claude-opus-5',
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
// Chỉ thêm cột khi thiếu — không nuốt lỗi thật (disk full, DB hỏng...)

function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing("memory_facts", "last_accessed_at", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("memory_facts", "access_count", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("query_logs", "model", "TEXT NOT NULL DEFAULT ''");
// Vector của fact — BLOB f32 little-endian, cùng định dạng với bản Rust (memory-assistant)
addColumnIfMissing("memory_facts", "embedding", "BLOB");

// --- Semantic layer ---

db.run(`
  CREATE TABLE IF NOT EXISTS fact_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id_1 INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    fact_id_2 INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (fact_id_1, fact_id_2),
    CHECK (fact_id_1 < fact_id_2)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_fact_relations_1 ON fact_relations (fact_id_1)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_fact_relations_2 ON fact_relations (fact_id_2)`);

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

// Rebuild index 1 lần duy nhất (mỗi restart rebuild lại là phí)
db.run(`CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

const ftsReady = db.query(`SELECT value FROM db_meta WHERE key = 'fts_rebuilt_at'`).get();
if (!ftsReady) {
  db.run(`INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')`);
  db.run(`INSERT INTO db_meta (key, value) VALUES ('fts_rebuilt_at', ?)`, [String(Date.now())]);
}
