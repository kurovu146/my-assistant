// src/db/queries.ts
// ============================================================
// Query Log CRUD — Analytics & logging
// ============================================================

import { db } from "./connection.ts";

export interface QueryStats {
  totalQueries: number;
  todayQueries: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgResponseMs: number;
  topTools: { name: string; count: number }[];
}

/** Object thay vì tham số vị trí: 5 số nguyên liền nhau rất dễ truyền nhầm thứ tự. */
export interface QueryLogEntry {
  userId: number;
  promptPreview: string;
  responseTimeMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  toolsUsed: string[];
  model?: string;
}

export function logQuery(entry: QueryLogEntry): void {
  db.run(
    `INSERT INTO query_logs (user_id, prompt_preview, response_time_ms, tokens_in, tokens_out,
                             cache_read_tokens, cache_creation_tokens, cost_usd, tools_used, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.promptPreview.slice(0, 50),
      entry.responseTimeMs,
      entry.tokensIn,
      entry.tokensOut,
      entry.cacheRead,
      entry.cacheWrite,
      entry.costUsd,
      entry.toolsUsed.join(","),
      entry.model ?? "",
      Date.now(),
    ],
  );
}

export function getQueryStats(userId: number): QueryStats {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const total = db
    .query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(tokens_in), 0) as tin, COALESCE(SUM(tokens_out), 0) as tout,
              COALESCE(SUM(cost_usd), 0) as cost, COALESCE(AVG(response_time_ms), 0) as avg_ms
       FROM query_logs WHERE user_id = ?`,
    )
    .get(userId) as any;

  const today = db
    .query(
      `SELECT COUNT(*) as cnt FROM query_logs WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, todayStart.getTime()) as any;

  // Tools lưu dạng CSV nên phải đếm ở JS → chỉ quét cửa sổ 30 ngày gần nhất
  // thay vì toàn bộ lịch sử (retention 90 ngày).
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const allTools = db
    .query(
      `SELECT tools_used FROM query_logs
       WHERE user_id = ? AND tools_used != '' AND created_at >= ?
       ORDER BY created_at DESC LIMIT 2000`,
    )
    .all(userId, thirtyDaysAgo) as any[];

  const toolCounts = new Map<string, number>();
  for (const row of allTools) {
    for (const tool of row.tools_used.split(",")) {
      const t = tool.trim();
      if (t) toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
    }
  }

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    totalQueries: total.cnt,
    todayQueries: today.cnt,
    totalTokensIn: total.tin,
    totalTokensOut: total.tout,
    totalCostUsd: total.cost,
    avgResponseMs: Math.round(total.avg_ms),
    topTools,
  };
}

// --- Usage theo kỳ (rolling) ---

export interface PeriodUsage {
  queries: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface ModelUsage {
  model: string;
  queries: number;
  costUsd: number;
}

export interface UsageReport {
  today: PeriodUsage;
  week: PeriodUsage;
  month: PeriodUsage;
  byModel: ModelUsage[];
}

/** Model rỗng ở log cũ vẫn phải hiện, nếu không tổng breakdown lệch so với tổng chung. */
const UNKNOWN_MODEL = "(không rõ)";

const PERIOD_METRICS = [
  ["queries", "1"],
  ["in", "tokens_in"],
  ["out", "tokens_out"],
  ["cread", "cache_read_tokens"],
  ["cwrite", "cache_creation_tokens"],
  ["cost", "cost_usd"],
] as const;

/** 6 cột tổng cho 1 khung — mỗi cột 1 tham số mốc thời gian, truyền theo đúng thứ tự này. */
function periodColumns(alias: string): string {
  return PERIOD_METRICS.map(
    ([name, expr]) =>
      `COALESCE(SUM(CASE WHEN created_at >= ? THEN ${expr} ELSE 0 END), 0) AS ${alias}_${name}`,
  ).join(",\n      ");
}

function readPeriod(row: Record<string, number>, alias: string): PeriodUsage {
  return {
    queries: row[`${alias}_queries`] ?? 0,
    tokensIn: row[`${alias}_in`] ?? 0,
    tokensOut: row[`${alias}_out`] ?? 0,
    cacheRead: row[`${alias}_cread`] ?? 0,
    cacheWrite: row[`${alias}_cwrite`] ?? 0,
    costUsd: row[`${alias}_cost`] ?? 0,
  };
}

/**
 * Tổng token/chi phí theo 3 khung rolling: hôm nay (từ 00:00), 7 ngày, 30 ngày.
 * Gộp cả 3 vào một câu SQL để chỉ quét bảng một lần.
 */
export function getUsageByPeriod(userId: number): UsageReport {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const now = Date.now();
  const bounds = {
    today: todayStart.getTime(),
    week: now - 7 * 86_400_000,
    month: now - 30 * 86_400_000,
  };

  const row = db
    .query(
      `SELECT
      ${periodColumns("today")},
      ${periodColumns("week")},
      ${periodColumns("month")}
     FROM query_logs WHERE user_id = ? AND created_at >= ?`,
    )
    .get(
      ...Array(PERIOD_METRICS.length).fill(bounds.today),
      ...Array(PERIOD_METRICS.length).fill(bounds.week),
      ...Array(PERIOD_METRICS.length).fill(bounds.month),
      userId,
      bounds.month, // lọc sẵn theo mốc xa nhất
    ) as Record<string, number>;

  const byModel = db
    .query(
      `SELECT COALESCE(NULLIF(model, ''), ?) AS model,
              COUNT(*) AS queries,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM query_logs WHERE user_id = ? AND created_at >= ?
       GROUP BY 1 ORDER BY cost DESC`,
    )
    .all(UNKNOWN_MODEL, userId, bounds.month) as { model: string; queries: number; cost: number }[];

  return {
    today: readPeriod(row, "today"),
    week: readPeriod(row, "week"),
    month: readPeriod(row, "month"),
    byModel: byModel.map((m) => ({ model: m.model, queries: m.queries, costUsd: m.cost })),
  };
}
