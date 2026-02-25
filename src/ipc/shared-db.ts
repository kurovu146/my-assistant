// src/ipc/shared-db.ts
// ============================================================
// Inter-Bot Communication — Shared SQLite DB
// ============================================================
//
// Kuro và Judy giao tiếp qua shared DB tại /home/kuro/shared-bot-messages.db
// WAL mode cho phép 2 process đọc/ghi đồng thời an toàn.
//
// Schema:
//   ipc_messages — tin nhắn giữa các bot
// ============================================================

import { Database } from "bun:sqlite";
import { logger } from "../logger.ts";

const IPC_DB_PATH = "/home/kuro/shared-bot-messages.db";

let ipcDb: Database | null = null;

export function getIpcDb(): Database {
  if (!ipcDb) {
    ipcDb = new Database(IPC_DB_PATH);
    ipcDb.run("PRAGMA journal_mode = WAL");
    ipcDb.run("PRAGMA busy_timeout = 5000");

    ipcDb.run(`
      CREATE TABLE IF NOT EXISTS ipc_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_bot TEXT NOT NULL,
        to_bot TEXT NOT NULL,
        message TEXT NOT NULL,
        reply_to INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        processed_at INTEGER
      )
    `);
    ipcDb.run(`CREATE INDEX IF NOT EXISTS idx_ipc_to_status ON ipc_messages (to_bot, status)`);
    ipcDb.run(`CREATE INDEX IF NOT EXISTS idx_ipc_reply_to ON ipc_messages (reply_to)`);

    logger.log("📨 IPC shared DB connected");
  }
  return ipcDb;
}

export function closeIpcDb(): void {
  if (ipcDb) {
    ipcDb.close();
    ipcDb = null;
  }
}

// --- Types ---

export interface IpcMessage {
  id: number;
  fromBot: string;
  toBot: string;
  message: string;
  replyTo: number | null;
  status: string;
  createdAt: number;
  processedAt: number | null;
}

// --- Send ---

export function sendIpcMessage(
  fromBot: string,
  toBot: string,
  message: string,
  replyTo?: number,
): IpcMessage {
  const db = getIpcDb();
  const now = Date.now();

  const stmt = db.prepare(
    `INSERT INTO ipc_messages (from_bot, to_bot, message, reply_to, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  );
  stmt.run(fromBot, toBot, message, replyTo ?? null, now);

  const id = Number(db.query("SELECT last_insert_rowid() as id").get()!.id);
  logger.log(`📨 IPC: ${fromBot} → ${toBot}: "${message.slice(0, 80)}..." (id: ${id})`);

  return {
    id,
    fromBot,
    toBot,
    message,
    replyTo: replyTo ?? null,
    status: "pending",
    createdAt: now,
    processedAt: null,
  };
}

// --- Claim pending (atomic transaction) ---

export function claimPendingMessages(botName: string): IpcMessage[] {
  const db = getIpcDb();

  const txn = db.transaction(() => {
    const rows = db
      .query(
        `SELECT id, from_bot, to_bot, message, reply_to, status, created_at, processed_at
         FROM ipc_messages
         WHERE to_bot = ? AND status = 'pending'
         ORDER BY created_at ASC LIMIT 5`,
      )
      .all(botName) as any[];

    if (rows.length === 0) return [];

    const ids = rows.map((r: any) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.run(
      `UPDATE ipc_messages SET status = 'processing', processed_at = ?
       WHERE id IN (${placeholders})`,
      [Date.now(), ...ids],
    );

    return rows.map((r: any): IpcMessage => ({
      id: r.id,
      fromBot: r.from_bot,
      toBot: r.to_bot,
      message: r.message,
      replyTo: r.reply_to,
      status: "processing",
      createdAt: r.created_at,
      processedAt: r.processed_at,
    }));
  });

  return txn();
}

// --- Mark done/error ---

export function markIpcMessageDone(messageId: number): void {
  const db = getIpcDb();
  db.run(
    `UPDATE ipc_messages SET status = 'done', processed_at = ? WHERE id = ?`,
    [Date.now(), messageId],
  );
}

export function markIpcMessageError(messageId: number): void {
  const db = getIpcDb();
  db.run(
    `UPDATE ipc_messages SET status = 'error', processed_at = ? WHERE id = ?`,
    [Date.now(), messageId],
  );
}

// --- Cleanup old messages ---

export function cleanupOldIpcMessages(maxAgeDays = 7): number {
  const db = getIpcDb();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result = db.run(
    `DELETE FROM ipc_messages WHERE created_at < ? AND status IN ('done', 'error')`,
    [cutoff],
  );
  return result.changes;
}
