#!/usr/bin/env bun
// scripts/memory-context.ts
// ============================================================
// SessionStart hook — bơm memory của bot Telegram vào phiên Claude Code
// ============================================================
//
// Bot Telegram và Claude Code CLI có hai kho memory riêng, không thấy nhau:
// bot ghi vào `sessions.db` (SQLite), CLI đọc file .md ở ~/.claude/projects/.
// Script này nối chiều SQLite → CLI.
//
// Chạy như hook chứ không phải tool, vì đo được trong chính bot này: mọi thứ
// đòi agent chủ động gọi đều không bao giờ được gọi (memory_save 0/100 lượt,
// knowledge base 0 bản ghi, MCP memory đã phải gỡ). Hook thì agent không có
// cơ hội quên.
//
// Nhận JSON của hook trên stdin, in JSON có `additionalContext` ra stdout.
// Mọi lỗi đều nuốt và in context rỗng: một phiên Claude Code không được chết
// vì cái kho memory phụ.
// ============================================================

import { Database } from "bun:sqlite";
import { resolve } from "path";

const DB_PATH = resolve(import.meta.dir, "..", "sessions.db");
const MAX_FACTS = 25;
const DECAY_THRESHOLD_DAYS = 30;

interface FactRow {
  fact: string;
  category: string;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number | null;
}

/** Giống scoreFact() ở src/memory/extraction.ts — recency + tần suất + phạt nếu lâu không đụng. */
function scoreFact(row: FactRow): number {
  const now = Date.now();
  const daysSinceUpdate = (now - row.updated_at) / 86_400_000;
  const daysSinceAccess = row.last_accessed_at
    ? (now - row.last_accessed_at) / 86_400_000
    : daysSinceUpdate;

  let score = Math.max(0, 100 - daysSinceUpdate);
  score += Math.min((row.access_count ?? 0) * 5, 50);
  if (daysSinceAccess > DECAY_THRESHOLD_DAYS) score *= 0.5;
  return score;
}

/**
 * Tìm project của bot khớp với cwd hiện tại.
 *
 * So sánh lowercase: bảng `projects` lưu `/Users/kuro/dev/funlife` còn cwd thật
 * là `/Users/kuro/Dev/funlife`. macOS không phân biệt hoa thường nên hai đường
 * dẫn này là một, nhưng so sánh chuỗi trần thì trượt và không fact nào được nạp.
 *
 * Chọn path dài nhất khớp: `/Users/kuro/dev` (project "dev") cũng là tiền tố của
 * mọi project con, lấy bừa cái đầu tiên sẽ ra nhầm project.
 */
function matchProject(db: Database, cwd: string): string {
  const rows = db.query(`SELECT name, path FROM projects`).all() as Array<{
    name: string;
    path: string;
  }>;
  const target = cwd.toLowerCase().replace(/\/+$/, "");

  let best = "";
  let bestLen = -1;
  for (const row of rows) {
    const base = (row.path || "").toLowerCase().replace(/\/+$/, "");
    if (!base) continue;
    if ((target === base || target.startsWith(base + "/")) && base.length > bestLen) {
      best = row.name;
      bestLen = base.length;
    }
  }
  return best;
}

function build(cwd: string): string {
  // readonly: bot đang chạy và giữ WAL, hook chỉ được đọc ké — tuyệt đối không
  // tạo bảng hay rebuild FTS (đó là lý do không import src/db/connection.ts).
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const project = matchProject(db, cwd);

    // Không khớp project nào → chỉ lấy fact chung, đừng đổ fact của project khác
    // vào một thư mục không liên quan.
    const rows = db
      .query(
        `SELECT fact, category, updated_at, last_accessed_at, access_count
         FROM memory_facts
         WHERE project IS NULL OR project = ?`,
      )
      .all(project) as FactRow[];

    if (rows.length === 0) return "";

    const top = rows
      .map((row) => ({ row, score: scoreFact(row) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FACTS);

    const grouped = new Map<string, string[]>();
    for (const { row } of top) {
      const list = grouped.get(row.category) ?? [];
      list.push(row.fact);
      grouped.set(row.category, list);
    }

    const scope = project ? `project "${project}"` : "phạm vi chung";
    let out = `## Memory từ bot Telegram (${scope})\n\n`;
    out += `Đây là fact bot my-assistant đã ghi nhớ qua các cuộc trò chuyện Telegram — `;
    out += `kho này tách khỏi memory file-based của Claude Code, nên không có trong MEMORY.md. `;
    out += `Dùng để hiểu ngữ cảnh; nếu mâu thuẫn với code hiện tại thì tin code.\n`;
    for (const [category, facts] of grouped) {
      out += `\n**${category}**\n`;
      for (const fact of facts) out += `- ${fact}\n`;
    }
    return out;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  let context = "";
  try {
    const raw = await Bun.stdin.text();
    const input = raw.trim() ? JSON.parse(raw) : {};
    context = build(String(input.cwd || process.cwd()));
  } catch {
    context = ""; // hỏng thì im lặng — không chặn phiên
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
      suppressOutput: true,
    }),
  );
}

await main();
