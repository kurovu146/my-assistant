// src/services/memory-consolidation.ts
// ============================================================
// Memory Consolidation — Gộp facts trùng/tương tự bằng Haiku
// ============================================================
// Học từ: OpenClaw 5-tier memory, SimpleMem compression
//
// Flow: load all facts → group similar → Haiku merge → update DB
// Chạy cron mỗi ngày 1 lần (2h sáng VN = 19:00 UTC).
// ============================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getUserFacts, saveFact, deleteFact, countFacts } from "../storage/db.ts";

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
  factsBeore: number;
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
    return { factsBeore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
  }

  // Prepare input cho Haiku
  const input = facts.map((f) => ({
    id: f.id,
    fact: f.fact,
    category: f.category,
    age_days: Math.round((Date.now() - f.updatedAt) / (1000 * 60 * 60 * 24)),
  }));

  try {
    const stream = query({
      prompt: JSON.stringify(input),
      options: {
        model: "claude-haiku-4-5-20251001",
        systemPrompt: CONSOLIDATION_PROMPT,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
      },
    });

    let resultText = "";
    for await (const message of stream) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ((block as any).type === "text") {
            resultText += (block as any).text;
          }
        }
      }
      if (message.type === "result" && "result" in message && message.result) {
        if (!resultText) resultText = message.result;
      }
    }

    if (!resultText.trim()) {
      return { factsBeore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
    }

    // Parse result
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { factsBeore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
    }

    const result = JSON.parse(jsonMatch[0]) as {
      keep: number[];
      merge: Array<{ delete_ids: number[]; new_fact: string; category: string }>;
    };

    if (!result.merge || result.merge.length === 0) {
      return { factsBeore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
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
    console.log(
      `🧹 Memory consolidation: user ${userId} — ${beforeCount} → ${afterCount} facts (merged ${result.merge.length} groups, deleted ${totalDeleted})`,
    );

    return {
      factsBeore: beforeCount,
      factsAfter: afterCount,
      merged: result.merge.length,
      deleted: totalDeleted,
    };
  } catch (error) {
    console.error("⚠️ Memory consolidation error:", error instanceof Error ? error.message : error);
    return { factsBeore: beforeCount, factsAfter: beforeCount, merged: 0, deleted: 0 };
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
  console.log("🧹 Memory Consolidation started (mỗi 24h)");
}

export function stopMemoryConsolidation(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("🧹 Memory Consolidation stopped");
  }
}

async function runConsolidation(): Promise<void> {
  for (const userId of targetUserIds) {
    await consolidateUserFacts(userId);
  }
}
