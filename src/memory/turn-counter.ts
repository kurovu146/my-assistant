// src/memory/turn-counter.ts
// ============================================================
// Bộ đếm lượt cho skill review
// ============================================================
//
// Tách khỏi skill-review.ts vì một lý do đo được: Stop hook của Claude Code chạy
// SAU MỖI LƯỢT trả lời và Claude Code chặn chờ nó xong. Nếu hook phải import
// skill-review.ts thì nó kéo theo cả `@anthropic-ai/claude-agent-sdk` — vài trăm ms
// nạp module cho một việc chỉ là cộng một số vào SQLite, mỗi lượt, ngay trước mặt
// anh Tuấn. Ở đây chỉ có bun:sqlite và config.
//
// Lưu ở db_meta thay vì biến trong process: bot restart bằng `pm2 restart` khá
// thường xuyên, còn hook thì mỗi lượt là một tiến trình MỚI — đếm trong RAM thì
// bộ đếm không bao giờ sống quá một lượt và review không bao giờ tới ngưỡng.
// ============================================================

import { db } from "../db/connection.ts";
import { config } from "../config.ts";

function turnKey(userId: number | string, project: string): string {
  return `skill_review_turns:${userId}:${project}`;
}

function readTurns(key: string): number {
  const row = db.query(`SELECT value FROM db_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeTurns(key: string, value: number): void {
  db.run(
    `INSERT INTO db_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)],
  );
}

/**
 * Ghi nhận một lượt vừa xong. Trả `true` đúng lượt chạm ngưỡng (và reset bộ đếm).
 *
 * Đếm theo (nguồn, project) chứ không đếm chung: mỗi project là một phiên riêng,
 * gộp bộ đếm lại thì review của project này bị kích hoạt bởi lượt của project kia
 * và fork sẽ đọc nhầm transcript. `userId` nhận cả chuỗi để phiên Claude Code CLI
 * (không có user Telegram nào) dùng được nguồn riêng: `noteTurn("cc", cwd)`.
 */
export function noteTurn(userId: number | string, project: string): boolean {
  const key = turnKey(userId, project);
  const next = readTurns(key) + 1;
  if (next >= config.skillReviewInterval) {
    writeTurns(key, 0);
    return true;
  }
  writeTurns(key, next);
  return false;
}
