// src/memory/consolidation.ts
// ============================================================
// Memory Consolidation — Gộp facts trùng/tương tự bằng Haiku
// ============================================================

import { getClaudeProvider } from "../claude/provider.ts";
import { getUserFacts, saveFact, deleteFact, countFacts, cleanupOldData } from "./repository.ts";
import { logger } from "../logger.ts";

const CONSOLIDATION_PROMPT = `Bạn là bộ tối ưu hóa bộ nhớ. Nhiệm vụ: gộp các facts trùng lặp hoặc tương tự thành facts ngắn gọn hơn.

Quy tắc:
- Gộp facts có nội dung tương tự/trùng lặp thành 1 fact duy nhất
- Giữ nguyên facts unique, không thay đổi
- Bảo toàn thông tin quan trọng: tên, ngày, quyết định, sở thích
- Không bịa thêm thông tin
- Giữ nguyên category gốc
- Nếu 2 facts mâu thuẫn, giữ fact MỚI HƠN

Input: JSON array of facts (mỗi fact có id, fact, category)
Output: JSON object:
{
  "keep": [id1, id2, ...],       // IDs giữ nguyên
  "merge": [                      // Nhóm cần merge
    {
      "delete_ids": [id3, id4],   // IDs bị xóa (đã gộp)
      "new_fact": "...",           // Fact mới sau gộp
      "category": "..."           // Category
    }
  ]
}

Nếu không có gì cần gộp, trả về: {"keep": [tất cả IDs], "merge": []}`;

interface ConsolidationResult {
  factsBefore: number;
  factsAfter: number;
  merged: number;
  deleted: number;
}

/**
 * Consolidate facts cho 1 user.
 * Dùng Haiku để phát hiện và gộp facts trùng.
 */
export async function consolidateUserFacts(userId: number): Promise<ConsolidationResult> {
  const facts = getUserFacts(userId, 100);
  const beforeCount = facts.length;

  // Skip nếu ít facts (không cần consolidate)
  if (facts.length < 10) {
    return { factsBefore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
  }

  // Prepare input cho Haiku
  const input = facts.map((f) => ({
    id: f.id,
    fact: f.fact,
    category: f.category,
    age_days: Math.round((Date.now() - f.updatedAt) / (1000 * 60 * 60 * 24)),
  }));

  try {
    const resultText = await getClaudeProvider().complete({
      prompt: JSON.stringify(input),
      systemPrompt: CONSOLIDATION_PROMPT,
    });

    if (!resultText) {
      return { factsBefore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
    }

    // Parse result
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { factsBefore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
    }

    const result = JSON.parse(jsonMatch[0]) as {
      keep: number[];
      merge: Array<{ delete_ids: number[]; new_fact: string; category: string }>;
    };

    if (!result.merge || result.merge.length === 0) {
      return { factsBefore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
    }

    // Execute merges
    let totalDeleted = 0;
    for (const group of result.merge) {
      if (!group.new_fact || !group.delete_ids || group.delete_ids.length === 0) continue;

      // Save merged fact
      saveFact(userId, group.new_fact, group.category || "general", "consolidation");

      // Delete old facts
      for (const id of group.delete_ids) {
        if (deleteFact(userId, id)) {
          totalDeleted++;
        }
      }
    }

    const afterCount = countFacts(userId);
    logger.log(
      `🧹 Memory consolidation: user ${userId} — ${beforeCount} → ${afterCount} facts (merged ${result.merge.length} groups, deleted ${totalDeleted})`,
    );

    return {
      factsBefore: beforeCount,
      factsAfter: afterCount,
      merged: result.merge.length,
      deleted: totalDeleted,
    };
  } catch (error) {
    logger.error("⚠️ Memory consolidation error:", error instanceof Error ? error.message : error);
    return { factsBefore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
  }
}

// --- Cron ---

let intervalId: ReturnType<typeof setInterval> | null = null;
let targetUserIds: number[] = [];

/**
 * Start memory consolidation cron.
 * Chạy mỗi 24h. Consolidate cho tất cả allowed users.
 */
export function startMemoryConsolidation(userIds: number[]): void {
  targetUserIds = userIds;

  // Chạy lần đầu sau 5 phút (để bot ổn định)
  setTimeout(() => runConsolidation(), 5 * 60 * 1000);

  // Cron mỗi 24h
  intervalId = setInterval(() => runConsolidation(), 24 * 60 * 60 * 1000);
  logger.log("🧹 Memory Consolidation started (mỗi 24h)");
}

export function stopMemoryConsolidation(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.log("🧹 Memory Consolidation stopped");
  }
}

async function runConsolidation(): Promise<void> {
  // Cleanup old data first
  const cleanup = cleanupOldData();
  if (cleanup.logsDeleted > 0 || cleanup.sessionsDeleted > 0) {
    logger.log(`🧹 Cleanup: deleted ${cleanup.logsDeleted} old logs, ${cleanup.sessionsDeleted} old sessions`);
  }

  // Then consolidate facts
  for (const userId of targetUserIds) {
    await consolidateUserFacts(userId);
  }
}
