#!/usr/bin/env bun
// scripts/assign-project.ts
// ============================================================
// Gán project cho các fact có sẵn trong memory_facts — dữ liệu này được
// tạo ra TRƯỚC khi tính năng multi-project tồn tại nên cột `project`
// toàn NULL. Script một lần, không có API cho task khác dùng.
//
// Mặc định DRY-RUN: chỉ in bảng đối chiếu để anh Tuấn duyệt trước.
// Thêm --write mới thật sự ghi (bọc transaction).
//
// Usage:
//   bun run scripts/assign-project.ts            (dry-run, không ghi gì)
//   bun run scripts/assign-project.ts --write    (ghi thật sau khi đã duyệt)
// ============================================================

import { db } from "../src/db/connection.ts";
import { getClaudeProvider } from "../src/claude/provider.ts";
import { resolveModelTier } from "../src/claude/router.ts";
import { normalizeProjectName } from "../src/db/projects.ts";

interface FactRow {
  id: number;
  category: string;
  fact: string;
}

interface RawAssignment {
  id: number;
  project: string | null;
}

const write = process.argv.includes("--write");

const facts = db.query(`SELECT id, category, fact FROM memory_facts ORDER BY id`).all() as FactRow[];

if (facts.length === 0) {
  console.log("Không có fact nào trong memory_facts — không có gì để gán.");
  process.exit(0);
}

let out: string;
try {
  out = await getClaudeProvider().complete({
    prompt:
      `<facts>\n${JSON.stringify(facts.map((f) => ({ id: f.id, fact: f.fact })), null, 1)}\n</facts>\n\n` +
      `Gán project cho từng fact. Chỉ trả JSON array [{"id": <id>, "project": "<tên>" | null}].`,
    systemPrompt:
      `Bạn phân loại fact theo dự án. Fact nhắc rõ tên một dự án thì gán tên đó ` +
      `(viết thường, dùng gạch ngang). Fact về sở thích, thói quen, thông tin cá nhân của người ` +
      `dùng — đúng với mọi dự án — thì trả null. Không chắc cũng trả null.`,
    model: resolveModelTier("balanced"),
    maxTurns: 2,
  });
} catch (err) {
  console.error("❌ Lỗi khi gọi Claude:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const match = out.match(/\[[\s\S]*\]/);
if (!match) {
  console.error("❌ Không parse được JSON:", out.slice(0, 200));
  process.exit(1);
}

// JSON.parse có thể throw nếu model bị cắt cụt giữa chừng (hết token) dù regex
// vẫn khớp được đoạn mở ngoặc `[...` — không được nuốt lỗi này, vì bước ghi
// bên dưới sẽ dựa trên `mapping` rỗng/sai mà vẫn chạy tiếp, đúng kiểu "ghi bừa"
// mà anh dặn phải tránh.
let parsed: unknown;
try {
  parsed = JSON.parse(match[0]);
} catch (err) {
  console.error("❌ JSON lỗi cú pháp:", err instanceof Error ? err.message : String(err));
  console.error(match[0].slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(parsed)) {
  console.error("❌ Kết quả không phải mảng:", match[0].slice(0, 200));
  process.exit(1);
}

const validIds = new Set(facts.map((f) => f.id));
const mapping = new Map<number, string | null>();
for (const r of parsed as RawAssignment[]) {
  if (typeof r?.id !== "number" || !validIds.has(r.id)) continue; // id lạ/model bịa — bỏ qua

  // Chuẩn hoá bằng đúng rule đặt tên project của Task 1 (`normalizeProjectName`):
  // model có thể trả "Baby Name Numerology" thay vì "baby-name-numerology", hoặc
  // lỡ trả tên chứa ký tự lạ. Không chuẩn hoá được thì coi như không chắc → null,
  // đúng nguyên tắc "không chắc cũng để null" chứ không cố đoán/sửa hộ.
  const normalized = typeof r.project === "string" ? normalizeProjectName(r.project) : null;
  mapping.set(r.id, normalized);
}

const missingIds = facts.filter((f) => !mapping.has(f.id));
if (missingIds.length > 0) {
  console.warn(
    `⚠️  ${missingIds.length} fact model không trả về trong JSON (coi như null): ` +
      missingIds.map((f) => f.id).join(", "),
  );
}

const changed = facts.filter((f) => mapping.get(f.id));
console.log(`\n${changed.length}/${facts.length} fact được gán project:\n`);
for (const f of changed) {
  console.log(`#${String(f.id).padEnd(4)} → ${String(mapping.get(f.id)).padEnd(22)} ${f.fact.slice(0, 55)}`);
}
console.log(`\n${facts.length - changed.length} fact để chung (null)`);

if (write) {
  const stmt = db.prepare(`UPDATE memory_facts SET project = ? WHERE id = ?`);
  db.transaction(() => {
    for (const f of changed) stmt.run(mapping.get(f.id)!, f.id);
  })();
  console.log("\n✅ Đã ghi (--write)");
} else {
  console.log("\n(dry-run — thêm --write để áp dụng)");
}
