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
// Bắt buộc để ON DELETE CASCADE hoạt động (xóa doc phải xóa chunk theo)
db.run("PRAGMA foreign_keys = ON");

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
// Cache tokens — thiếu hai cột này thì tokens_in gần như vô nghĩa với agent nhiều turn
addColumnIfMissing("query_logs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("query_logs", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
// Vector của fact — BLOB f32 little-endian, cùng định dạng với bản Rust (memory-assistant)
addColumnIfMissing("memory_facts", "embedding", "BLOB");

// --- Multi-project ---

addColumnIfMissing("sessions", "project", "TEXT NOT NULL DEFAULT ''");
// Nullable CÓ CHỦ Ý: NULL nghĩa là "fact chung, đúng cho mọi project",
// khác hẳn chuỗi rỗng của sessions (nghĩa là "chưa chọn project").
addColumnIfMissing("memory_facts", "project", "TEXT");

db.run(`
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS current_project (
    user_id INTEGER PRIMARY KEY,
    project TEXT NOT NULL
  )
`);

// active_sessions phải đổi PRIMARY KEY từ (user_id) sang (user_id, project).
// SQLite không ALTER được PK nên phải tạo bảng mới rồi đổi tên. Chỉ chạy khi
// bảng cũ chưa có cột project, nhờ vậy restart nhiều lần không lặp.
const activeCols = db.query(`PRAGMA table_info(active_sessions)`).all() as { name: string }[];
if (activeCols.length > 0 && !activeCols.some((c) => c.name === "project")) {
  db.transaction(() => {
    db.run(`
      CREATE TABLE active_sessions_v2 (
        user_id INTEGER NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL,
        PRIMARY KEY (user_id, project)
      )
    `);
    db.run(
      `INSERT OR IGNORE INTO active_sessions_v2 (user_id, project, session_id)
       SELECT user_id, '', session_id FROM active_sessions`,
    );
    db.run(`DROP TABLE active_sessions`);
    db.run(`ALTER TABLE active_sessions_v2 RENAME TO active_sessions`);
  })();
}

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

// --- Knowledge base ---

db.run(`
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user ON knowledge_documents (user_id, created_at)`);

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_docs_fts USING fts5(
    title, content,
    content='knowledge_documents',
    content_rowid='id'
  )
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS knowledge_docs_ai AFTER INSERT ON knowledge_documents BEGIN
    INSERT INTO knowledge_docs_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS knowledge_docs_ad AFTER DELETE ON knowledge_documents BEGIN
    INSERT INTO knowledge_docs_fts(knowledge_docs_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
  END
`);

db.run(`
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at INTEGER NOT NULL,
    UNIQUE (doc_id, chunk_index)
  )
`);

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
    content, content='knowledge_chunks', content_rowid='id'
  )
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
    INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.id, new.content);
  END
`);
db.run(`
  CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
    INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
  END
`);

// --- Entity graph ---

db.run(`
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name, entity_type)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_entities_user ON entities (user_id, name)`);

db.run(`
  CREATE TABLE IF NOT EXISTS entity_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (entity_id, source_type, source_id)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_entity_mentions ON entity_mentions (entity_id)`);

// Fact ↔ tài liệu: fact nào rút ra từ doc nào
db.run(`
  CREATE TABLE IF NOT EXISTS memory_kb_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    doc_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (fact_id, doc_id)
  )
`);

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
