// src/db/user-model.ts
// ============================================================
// Model per-user — lựa chọn model qua /model, giữ qua các phiên
// ============================================================

import { db } from "./connection.ts";

/** Model user đã chọn, hoặc "" nếu chưa chọn (→ dùng config.claudeModel) */
export function getUserModel(userId: number): string {
  const row = db
    .query(`SELECT model FROM user_model WHERE user_id = ?`)
    .get(userId) as { model: string } | null;
  return row?.model || "";
}

export function setUserModel(userId: number, model: string): void {
  db.run(
    `INSERT INTO user_model (user_id, model, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
    [userId, model, Date.now()],
  );
}

/** Quay về model mặc định của config */
export function clearUserModel(userId: number): void {
  db.run(`DELETE FROM user_model WHERE user_id = ?`, [userId]);
}
