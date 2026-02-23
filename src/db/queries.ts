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

export function logQuery(
  userId: number,
  promptPreview: string,
  responseTimeMs: number,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  toolsUsed: string[],
  model: string = "",
): void {
  db.run(
    `INSERT INTO query_logs (user_id, prompt_preview, response_time_ms, tokens_in, tokens_out, cost_usd, tools_used, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      promptPreview.slice(0, 50),
      responseTimeMs,
      tokensIn,
      tokensOut,
      costUsd,
      toolsUsed.join(","),
      model,
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

  const allTools = db
    .query(`SELECT tools_used FROM query_logs WHERE user_id = ? AND tools_used != ''`)
    .all(userId) as any[];

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
