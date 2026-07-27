// tests/unit.test.ts
// Chạy: bun test
// Cô lập môi trường (DB :memory:, tắt Voyage) nằm ở tests/setup.ts — preload qua
// bunfig.toml. Đặt ở đây không có tác dụng vì `import` được hoist lên trước.

import { expect, mock, test } from "bun:test";
import { resolve } from "path";
import { tmpdir } from "os";
import { splitMessage } from "../src/telegram/formatter.ts";
import { parseModelOverride, resolveModelTier } from "../src/claude/router.ts";
import { filterSensitiveContent } from "../src/telegram/content-filter.ts";
import { saveFact, searchFacts, toFtsQuery } from "../src/memory/repository.ts";
import { getUsageByPeriod, logQuery, type QueryLogEntry } from "../src/db/queries.ts";
import { db } from "../src/db/connection.ts";
import {
  bytesToEmbedding,
  cosineSimilarity,
  embeddingToBytes,
  hybridScore,
} from "../src/memory/embedding.ts";
import { searchFactsHybrid } from "../src/memory/semantic.ts";
import { chunkText } from "../src/memory/knowledge.ts";
import { buildContextSnippet, parseEntities } from "../src/memory/entities.ts";

// --- FTS5: keyword thô từng làm memory_search ném lỗi cú pháp ---

test("toFtsQuery làm keyword thô chạy được trên FTS5 MATCH", () => {
  const runMatch = (keyword: string) =>
    db
      .query(`SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ? LIMIT 1`)
      .all(keyword);

  // Không escape thì đây là cú pháp FTS5 → SQLite ném lỗi
  for (const keyword of ["email: tuan", "AND", "a-b", 'say "hi"', "tại sao không dùng Node"]) {
    expect(() => runMatch(toFtsQuery(keyword))).not.toThrow();
  }

  // Mỗi token là một phrase riêng, nối OR — nếu gộp cả câu thành một cụm thì
  // câu hỏi dài sẽ không khớp gì và FTS đóng góp 0 vào điểm hybrid.
  expect(toFtsQuery("dùng Bun")).toBe('"dùng" OR "Bun"');
  expect(toFtsQuery('say "hi"')).toBe('"say" OR """hi"""');
  expect(toFtsQuery("Godot")).toBe('"Godot"');
});

test("searchFacts khớp được câu hỏi nhiều từ nhờ OR token", () => {
  saveFact(3, "Anh dùng Bun thay cho Node.js", "preference");

  // Không có fact nào chứa nguyên cụm này, nhưng token "Bun" thì có
  expect(searchFacts(3, "tại sao anh chọn Bun").length).toBeGreaterThan(0);
});

test("searchFacts vẫn tìm được fact với keyword thường", () => {
  saveFact(1, "Anh dùng email: tuan@example.com cho công việc", "personal");
  saveFact(1, "Project BasoTien dùng Go và Godot", "project");

  expect(searchFacts(1, "Godot").length).toBeGreaterThan(0);
  expect(() => searchFacts(1, "email: tuan")).not.toThrow();
});

// --- Whitelist fail-closed: bot chạy shell nên không được mở mặc định ---

async function loadConfigWith(env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../src/config.ts")], {
    cwd: tmpdir(), // tránh Bun tự nạp .env của project
    env: { PATH: process.env.PATH ?? "", TELEGRAM_BOT_TOKEN: "test-token", ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

test("config chặn khởi động khi whitelist rỗng hoặc sai định dạng", async () => {
  expect(await loadConfigWith({})).toBe(1);
  expect(await loadConfigWith({ TELEGRAM_ALLOWED_USERS: "abc,123" })).toBe(1);
  expect(await loadConfigWith({ TELEGRAM_ALLOWED_USERS: "123", CLAUDE_MAX_TURNS: "nhiều" })).toBe(1);

  expect(await loadConfigWith({ TELEGRAM_ALLOWED_USERS: "123,456" })).toBe(0);
  expect(await loadConfigWith({ ALLOW_ALL_USERS: "1" })).toBe(0);
}, 15_000);

// --- Vector helpers (định dạng phải khớp bản Rust) ---

test("embedding round-trip qua BLOB giữ nguyên giá trị f32", () => {
  const original = [0.125, -0.5, 0, 1, -0.03125];
  const restored = bytesToEmbedding(embeddingToBytes(original));

  expect(restored).toEqual(original); // các giá trị này biểu diễn chính xác trong f32
  expect(embeddingToBytes(original).byteLength).toBe(original.length * 4);
});

test("cosineSimilarity xử lý đúng các trường hợp biên", () => {
  expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0); // khác độ dài
  expect(cosineSimilarity([], [])).toBe(0);
  expect(cosineSimilarity([0, 0], [1, 1])).toBe(0); // vector 0 → không chia cho 0
});

test("hybridScore bỏ qua vector khi không có kết quả vector nào", () => {
  expect(hybridScore(0.8, 0, false)).toBe(0.8);
  expect(hybridScore(0.5, 1, true)).toBeCloseTo(0.4 * 0.5 + 0.6 * 1, 6);
});

// --- Semantic search phải chạy được khi tắt embedding ---

test("searchFactsHybrid rơi về FTS khi không có VOYAGE_API_KEY", async () => {
  saveFact(2, "Anh dùng Bun thay cho Node.js", "preference");
  saveFact(2, "Project BasoTien viết bằng Go", "project");

  const hits = await searchFactsHybrid(2, "Bun");

  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.fact.fact).toContain("Bun");
  expect(hits[0]!.related).toEqual([]); // chưa embed thì không có liên kết
});

// --- Knowledge base: chunking ---

test("chunkText cắt theo đoạn văn, không cắt giữa đoạn", () => {
  const para = (n: number) => `Đoạn ${n}. `.repeat(30).trim(); // ~300 ký tự
  const doc = [para(1), para(2), para(3), para(4), para(5)].join("\n\n");

  const chunks = chunkText(doc, 700);

  expect(chunks.length).toBeGreaterThan(1);
  // Không đoạn nào bị xé đôi: mỗi đoạn gốc nằm trọn trong đúng một chunk
  for (let i = 1; i <= 5; i++) {
    expect(chunks.filter((c) => c.includes(`Đoạn ${i}.`)).length).toBe(1);
  }
  // Ghép lại đủ nội dung
  expect(chunks.join("\n\n").replace(/\s+/g, " ")).toBe(doc.replace(/\s+/g, " "));
});

test("chunkText xử lý input rỗng và đoạn dài hơn giới hạn", () => {
  expect(chunkText("")).toEqual([]);
  expect(chunkText("   \n\n   ")).toEqual([]);

  const huge = "x".repeat(3000);
  expect(chunkText(huge, 1000)).toEqual([huge]); // không xé giữa câu
});

// --- Entity extraction: parse output của model ---

test("parseEntities lọc bỏ phần tử sai định dạng", () => {
  const good = '[{"name": "Bun", "type": "technology"}, {"name": "BasoTien", "type": "project"}]';
  expect(parseEntities(good)).toEqual([
    { name: "Bun", type: "technology" },
    { name: "BasoTien", type: "project" },
  ]);

  // model hay chèn chữ quanh JSON
  expect(parseEntities(`Đây là kết quả:\n${good}\nHết.`).length).toBe(2);

  expect(parseEntities('[{"name": "X", "type": "khong_hop_le"}]')).toEqual([]);
  expect(parseEntities('[{"name": "", "type": "person"}]')).toEqual([]);
  expect(parseEntities("không phải JSON")).toEqual([]);
  expect(parseEntities("[]")).toEqual([]);
});

test("buildContextSnippet lấy đoạn quanh entity", () => {
  const text = "Anh Tuấn đang xây dựng project BasoTien bằng Go và Godot Engine cho vui.";

  const snippet = buildContextSnippet(text, "BasoTien");
  expect(snippet).toContain("BasoTien");
  expect(snippet.length).toBeLessThanOrEqual(105);

  expect(buildContextSnippet(text, "KhôngCóTrongVănBản")).toBe("");
});

// --- Usage stats theo kỳ (rolling) ---

const DAY = 86_400_000;

/** Ghi 1 log rồi lùi created_at về quá khứ — logQuery cố tình không nhận created_at. */
function seedLog(userId: number, ageMs: number, over: Partial<QueryLogEntry> = {}): void {
  logQuery({
    userId,
    promptPreview: "test",
    responseTimeMs: 1000,
    tokensIn: 100,
    tokensOut: 200,
    cacheRead: 1000,
    cacheWrite: 50,
    costUsd: 0.5,
    toolsUsed: [],
    model: "claude-opus-5",
    ...over,
  });
  if (ageMs > 0) {
    db.run(`UPDATE query_logs SET created_at = ? WHERE id = (SELECT MAX(id) FROM query_logs)`, [
      Date.now() - ageMs,
    ]);
  }
}

test("getUsageByPeriod tách đúng 3 khung rolling", () => {
  const userId = 10;
  seedLog(userId, 0); // ngay bây giờ → chắc chắn thuộc hôm nay
  seedLog(userId, 3 * DAY);
  seedLog(userId, 20 * DAY);
  seedLog(userId, 100 * DAY); // ngoài mọi khung

  const report = getUsageByPeriod(userId);

  expect(report.today.queries).toBe(1);
  expect(report.week.queries).toBe(2);
  expect(report.month.queries).toBe(3);
});

test("getUsageByPeriod loại log vừa vượt biên 30 ngày", () => {
  seedLog(11, 30 * DAY + 60_000); // quá 1 phút
  expect(getUsageByPeriod(11).month.queries).toBe(0);

  seedLog(12, 29 * DAY);
  expect(getUsageByPeriod(12).month.queries).toBe(1);
});

test("getUsageByPeriod cộng dồn cache tokens và cost", () => {
  const userId = 13;
  seedLog(userId, 0, { cacheRead: 1_000_000, cacheWrite: 25_000, tokensIn: 500, costUsd: 1.5 });
  seedLog(userId, DAY, { cacheRead: 2_000_000, cacheWrite: 75_000, tokensIn: 300, costUsd: 2.5 });

  const report = getUsageByPeriod(userId);

  expect(report.today.cacheRead).toBe(1_000_000);
  expect(report.week.cacheRead).toBe(3_000_000);
  expect(report.week.cacheWrite).toBe(100_000);
  expect(report.week.tokensIn).toBe(800);
  expect(report.week.costUsd).toBeCloseTo(4, 6);
});

test("getUsageByPeriod gom theo model, log thiếu model không bị bỏ sót", () => {
  const userId = 14;
  seedLog(userId, 0, { model: "claude-sonnet-5", costUsd: 1 });
  seedLog(userId, DAY, { model: "claude-opus-5", costUsd: 5 });
  seedLog(userId, 2 * DAY, { model: "claude-opus-5", costUsd: 3 });
  seedLog(userId, 3 * DAY, { model: "", costUsd: 0.5 });

  const { byModel } = getUsageByPeriod(userId);

  // Sắp theo cost giảm dần
  expect(byModel.map((m) => m.model)).toEqual([
    "claude-opus-5",
    "claude-sonnet-5",
    "(không rõ)",
  ]);
  expect(byModel[0]!.queries).toBe(2);
  expect(byModel[0]!.costUsd).toBeCloseTo(8, 6);
});

test("getUsageByPeriod trả về số 0 khi user chưa có query nào", () => {
  const report = getUsageByPeriod(999);

  expect(report.today.queries).toBe(0);
  expect(report.month.costUsd).toBe(0);
  expect(report.month.cacheRead).toBe(0);
  expect(report.byModel).toEqual([]);
});

// --- Telegram 4096 char limit ---

test("splitMessage giữ code block cân bằng khi cắt", () => {
  const long = "```go\n" + "fmt.Println(1)\n".repeat(400) + "```";
  const parts = splitMessage(long);

  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(4096);
    expect((part.match(/```/g) || []).length % 2).toBe(0);
  }
});

// --- Model override ---

test("parseModelOverride tách tier và phần còn lại", () => {
  expect(parseModelOverride("dùng opus viết hàm sort")).toEqual({
    tier: "powerful",
    rest: "viết hàm sort",
  });
  expect(parseModelOverride("use fast tóm tắt file")?.tier).toBe("fast");
  expect(parseModelOverride("dùng bừa cái gì đó")).toBeNull();
  expect(resolveModelTier("balanced")).toBe("claude-sonnet-5");
});

// --- Redact secrets trước khi gửi Telegram ---

test("filterSensitiveContent che token và giữ nguyên text thường", () => {
  const result = filterSensitiveContent(
    "token là sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234 nhé",
  );
  expect(result.text).not.toContain("sk-ant-api03");
  expect(result.text).toContain("[REDACTED]");
  expect(result.redactedCount).toBe(1);

  expect(filterSensitiveContent("chỉ là câu bình thường").redactedCount).toBe(0);
});

// --- Consolidation phải embed fact vừa gộp ---
// Đặt cuối file: mock.module thay module toàn cục nên không được ảnh hưởng test trên.

test("consolidation embed và liên kết fact vừa gộp", async () => {
  const userId = 4;
  const ids = Array.from({ length: 12 }, (_, i) =>
    saveFact(userId, `Fact số ${i} về project BasoTien`, "project").id,
  );
  const deleteIds = ids.slice(0, 3);

  const embedCalls: { factId: number; text: string }[] = [];
  const realSemantic = await import("../src/memory/semantic.ts");
  mock.module("../src/memory/semantic.ts", () => ({
    ...realSemantic,
    embedAndLinkFact: async (_userId: number, factId: number, text: string) => {
      embedCalls.push({ factId, text });
      return [];
    },
  }));
  mock.module("../src/claude/provider.ts", () => ({
    getClaudeProvider: () => ({
      complete: async () =>
        JSON.stringify({
          keep: ids.slice(3),
          merge: [{ delete_ids: deleteIds, new_fact: "BasoTien dùng Go và Godot", category: "project" }],
        }),
    }),
  }));

  const { consolidateUserFacts } = await import("../src/memory/consolidation.ts");
  const result = await consolidateUserFacts(userId);

  expect(result.merged).toBe(1);
  expect(result.deleted).toBe(3);

  // Fact gộp là fact quan trọng nhất — không có vector thì nó rơi khỏi semantic search
  expect(embedCalls.length).toBe(1);
  expect(embedCalls[0]!.text).toBe("BasoTien dùng Go và Godot");
  // Phải embed đúng fact MỚI, không phải fact vừa bị xóa
  expect(deleteIds).not.toContain(embedCalls[0]!.factId);
});
