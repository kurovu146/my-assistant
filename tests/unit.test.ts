// tests/unit.test.ts
// Chạy: bun test
// Cô lập môi trường (DB :memory:, tắt Voyage) nằm ở tests/setup.ts — preload qua
// bunfig.toml. Đặt ở đây không có tác dụng vì `import` được hoist lên trước.

import { expect, mock, test } from "bun:test";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { formatTokenCount, formatUsageTotal, splitMessage } from "../src/telegram/formatter.ts";
import { parseModelOverride, parseTier, resolveModelTier, tierOfModel } from "../src/claude/router.ts";
import { clearUserModel, getUserModel, setUserModel } from "../src/db/user-model.ts";
import { filterSensitiveContent } from "../src/telegram/content-filter.ts";
import {
  saveFact,
  searchFacts,
  getUserFacts,
  toFtsQuery,
  getFactsByCategory,
  countFacts,
  linkFacts,
  getRelatedFacts,
} from "../src/memory/repository.ts";
import { getUsageByPeriod, logQuery, type QueryLogEntry } from "../src/db/queries.ts";
import { db } from "../src/db/connection.ts";
import { config } from "../src/config.ts";
import { normalizeProjectName, resolveProjectPath, ensureProject, listProjects, getCurrentProject, setCurrentProject } from "../src/db/projects.ts";
import { getActiveSession, createSession, clearActiveSession, getRecentSessions } from "../src/db/sessions.ts";
import { formatProjectList, formatSkillList } from "../src/telegram/commands.ts";
import {
  bytesToEmbedding,
  cosineSimilarity,
  embeddingToBytes,
  hybridScore,
} from "../src/memory/embedding.ts";
import { searchFactsHybrid } from "../src/memory/semantic.ts";
import { chunkText } from "../src/memory/knowledge.ts";
import { buildExtractionPrompt, EXTRACT_PROMPT } from "../src/memory/extraction.ts";
import {
  CONSOLIDATION_PROMPT,
  markConsolidated,
  shouldConsolidateNow,
} from "../src/memory/consolidation.ts";
import { categoryGuide, MEMORY_CATEGORIES } from "../src/memory/categories.ts";
import { buildContextSnippet, parseEntities } from "../src/memory/entities.ts";

// --- Project normalization and path resolution ---

test("normalizeProjectName từ chối tên có thể thoát khỏi thư mục gốc", () => {
  // Tên đi thẳng vào cwd của agent — cho phép ".." là cho agent chạy ngoài ~/dev
  expect(normalizeProjectName("../etc")).toBeNull();
  expect(normalizeProjectName("a/b")).toBeNull();
  expect(normalizeProjectName("..")).toBeNull();
  expect(normalizeProjectName("")).toBeNull();
  expect(normalizeProjectName("   ")).toBeNull();
  expect(normalizeProjectName("x".repeat(65))).toBeNull();
  expect(normalizeProjectName("Tên Có Dấu")).toBeNull();

  expect(normalizeProjectName("my-assistant")).toBe("my-assistant");
  expect(normalizeProjectName("  Funlife  ")).toBe("funlife"); // trim + lowercase
  expect(normalizeProjectName("baby_name.v2")).toBe("baby_name.v2");
});

test("resolveProjectPath phân giải theo baseDir tuỳ chỉnh — hermetic, không phụ thuộc .env hay filesystem thật", () => {
  // Dựng thư mục gốc giả lập trong tmp, né phụ thuộc vào CLAUDE_WORKING_DIR thật
  // (theo đúng convention test "config chặn khởi động khi whitelist rỗng" ở dưới)
  const root = mkdtempSync(join(tmpdir(), "resolve-project-"));
  const base = join(root, "base");
  mkdirSync(base);
  mkdirSync(join(base, "my-assistant"));
  writeFileSync(join(base, "package.json"), "{}"); // giả lập file trùng regex tên project
  // Thư mục CÓ THẬT nằm ngoài base — nếu traversal lọt qua thì test dưới đây
  // sẽ bắt được (không phải chỉ dựa vào việc "/etc" tình cờ không tồn tại)
  mkdirSync(join(root, "outside"));

  try {
    // 1. Thư mục có thật → exists: true
    const real = resolveProjectPath("my-assistant", base);
    expect(real).toEqual({ path: join(base, "my-assistant"), exists: true });

    // 2. Tên không tồn tại → lùi về thư mục gốc, exists: false
    const missing = resolveProjectPath("khong-ton-tai-abcxyz", base);
    expect(missing).toEqual({ path: base, exists: false });

    // 3. Một FILE (không phải thư mục) → exists: false — existsSync cũ trả true sai,
    // agent sẽ nhận cwd trỏ vào file và hỏng ngay lúc khởi động
    const file = resolveProjectPath("package.json", base);
    expect(file).toEqual({ path: base, exists: false });

    // 4. Traversal bị normalizeProjectName chặn từ bên trong resolveProjectPath —
    // hàm phải tự an toàn, không dựa vào caller nhớ validate trước. Thư mục
    // "outside" tồn tại thật nên nếu validate bị bỏ qua, join() sẽ thoát ra
    // ngoài base và trả exists:true sai — test này bắt được điều đó.
    const traversal = resolveProjectPath("../outside", base);
    expect(traversal).toEqual({ path: base, exists: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectPath mặc định dùng config.claudeWorkingDir khi không truyền baseDir", () => {
  const missing = resolveProjectPath("khong-ton-tai-mac-dinh-xyz");
  expect(missing).toEqual({ path: config.claudeWorkingDir, exists: false });
});

// --- Project registry CRUD ---

test("ensureProject tạo mới rồi tái sử dụng", () => {
  const first = ensureProject("du-an-thu-nghiem");
  expect(first).not.toBeNull();
  expect(first!.created).toBe(true);
  expect(first!.project.name).toBe("du-an-thu-nghiem");

  const second = ensureProject("Du-An-Thu-Nghiem"); // khác hoa thường
  expect(second!.created).toBe(false); // đã chuẩn hoá nên là cùng một project

  expect(ensureProject("../thoat-ra")).toBeNull();
});

test("getCurrentProject trả chuỗi rỗng khi user chưa chọn project", () => {
  expect(getCurrentProject(901)).toBe("");

  ensureProject("alpha");
  setCurrentProject(901, "alpha");
  expect(getCurrentProject(901)).toBe("alpha");
});

test("getCurrentProject trả chuỗi rỗng khi con trỏ mồ côi (project không còn trong bảng projects)", () => {
  // Chèn thẳng con trỏ trỏ tới tên KHÔNG có trong bảng projects — mô phỏng project
  // bị xoá sau khi đã được chọn. Task 4/5/6/7 đều dựa vào "" ở nhánh này để lùi về
  // thư mục gốc thay vì cwd/lọc dữ liệu theo một project ma không còn tồn tại.
  setCurrentProject(904, "project-da-bi-xoa-abcxyz");
  expect(getCurrentProject(904)).toBe("");
});

test("ensureProject phân giải lại path khi thư mục dự án xuất hiện sau lúc đăng ký", () => {
  // Hermetic — dùng baseDir tuỳ chỉnh (mkdtempSync) thay vì phụ thuộc ~/dev thật,
  // theo đúng cách resolveProjectPath đã làm ở test phía trên.
  const root = mkdtempSync(join(tmpdir(), "ensure-project-"));
  const base = join(root, "base");
  mkdirSync(base);

  try {
    // Đăng ký lần đầu khi thư mục thật CHƯA tồn tại → path fallback về baseDir
    const first = ensureProject("thu-muc-tre", base);
    expect(first!.project.path).toBe(base);

    // Thư mục xuất hiện sau khi đã đăng ký — ensureProject lần sau phải phân
    // giải lại, không giữ nguyên path cũ (nếu không /p sẽ hiển thị đường dẫn cũ
    // trong khi lời gọi resolveProjectPath riêng lại thấy thư mục tồn tại)
    mkdirSync(join(base, "thu-muc-tre"));
    const second = ensureProject("thu-muc-tre", base);
    expect(second!.created).toBe(false);
    expect(second!.project.path).toBe(join(base, "thu-muc-tre"));

    // DB phải được cập nhật thật, không chỉ object trả về trong bộ nhớ
    const stored = listProjects().find((p) => p.name === "thu-muc-tre");
    expect(stored?.path).toBe(join(base, "thu-muc-tre"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjects đếm số phiên của từng project", () => {
  ensureProject("proj-a");
  db.run(
    `INSERT OR REPLACE INTO sessions (user_id, session_id, model, created_at, last_active_at, title, project)
     VALUES (?, ?, 'claude-opus-5', ?, ?, 'x', ?)`,
    [902, "s1", Date.now(), Date.now(), "proj-a"],
  );

  const found = listProjects().find((p) => p.name === "proj-a");
  expect(found?.sessionCount).toBe(1);
});

// --- /p: format danh sách project (Task 6) ---

test("formatProjectList đánh dấu project đang mở", () => {
  const out = formatProjectList(
    [
      { name: "alpha", path: "/dev/alpha", createdAt: 0, lastUsedAt: Date.now(), sessionCount: 3 },
      { name: "beta", path: "/dev/beta", createdAt: 0, lastUsedAt: Date.now(), sessionCount: 1 },
    ],
    "beta",
  );

  expect(out).toContain("alpha");
  expect(out).toContain("beta");
  expect(out).toMatch(/▸\s*beta/); // project hiện tại có dấu ▸
  expect(out).not.toMatch(/▸\s*alpha/);
});

test("formatProjectList hướng dẫn khi chưa có project nào", () => {
  expect(formatProjectList([], "")).toContain("/p ");
});

test("formatProjectList đánh dấu ⚠️ đúng cho cả 2 dạng project không có thư mục riêng", () => {
  // Finding review Task 6: có 2 đường dẫn tới "agent đang chạy nhầm thư mục gốc",
  // check kiểu cũ (projectDirExists(p.path)) chỉ bắt được 1:
  //   1. Project TỪNG có thư mục riêng, path lưu trong DB là đường dẫn thật, rồi
  //      thư mục đó bị xoá sau → bắt được cả 2 cách check (path cũ trỏ vào chỗ
  //      không còn tồn tại).
  //   2. Project được tạo TRƯỚC KHI thư mục riêng từng tồn tại → ensureProject
  //      lưu path = baseDir (fallback) → check theo path cũ luôn thấy "tồn tại"
  //      vì baseDir luôn có thật, dù project chưa từng có thư mục riêng. Đây là
  //      case bị lọt lưới, phải phân giải lại từ TÊN (resolveProjectPath) mới bắt được.
  const base = mkdtempSync(join(tmpdir(), "myasst-fmtlist-"));
  const conPath = join(base, "con-thu-muc");
  mkdirSync(conPath);
  const mistPath = join(base, "da-bi-xoa"); // không bao giờ mkdirSync — mô phỏng "đã xoá"

  try {
    const out = formatProjectList(
      [
        { name: "con-thu-muc", path: conPath, createdAt: 0, lastUsedAt: Date.now(), sessionCount: 1 },
        // path = base — đúng giá trị fallback mà ensureProject lưu khi tạo project
        // lúc thư mục riêng CHƯA TỪNG tồn tại (case bị lọt lưới)
        { name: "chua-tung-co-rieng", path: base, createdAt: 0, lastUsedAt: Date.now(), sessionCount: 0 },
        { name: "da-bi-xoa", path: mistPath, createdAt: 0, lastUsedAt: Date.now(), sessionCount: 2 },
      ],
      "",
      base,
    );

    const lines = out.split("\n");
    const okLine = lines.find((l) => l.includes("con-thu-muc"));
    const neverHadDirLine = lines.find((l) => l.includes("chua-tung-co-rieng"));
    const missingLine = lines.find((l) => l.includes("da-bi-xoa"));
    expect(okLine).not.toContain("⚠️");
    expect(neverHadDirLine).toContain("⚠️");
    expect(missingLine).toContain("⚠️");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Multi-project: schema migration ---

test("migration tạo đủ bảng và cột cho multi-project", () => {
  const cols = (t: string) =>
    (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

  expect(cols("sessions")).toContain("project");
  expect(cols("memory_facts")).toContain("project");
  expect(cols("projects")).toEqual(
    expect.arrayContaining(["name", "path", "created_at", "last_used_at"]),
  );
  expect(cols("current_project")).toEqual(expect.arrayContaining(["user_id", "project"]));

  // active_sessions phải khoá theo CẶP, nếu không mỗi user vẫn chỉ giữ được 1 phiên
  const pk = (db.query(`PRAGMA table_info(active_sessions)`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .map((c) => c.name)
    .sort();
  expect(pk).toEqual(["project", "user_id"]);
});

test("hai project giữ được hai phiên cùng lúc", () => {
  db.run(`INSERT OR REPLACE INTO active_sessions (user_id, project, session_id) VALUES (?, ?, ?)`,
    [900, "alpha", "sess-alpha"]);
  db.run(`INSERT OR REPLACE INTO active_sessions (user_id, project, session_id) VALUES (?, ?, ?)`,
    [900, "beta", "sess-beta"]);

  const rows = db.query(`SELECT project, session_id FROM active_sessions WHERE user_id = ? ORDER BY project`)
    .all(900) as { project: string; session_id: string }[];

  expect(rows).toEqual([
    { project: "alpha", session_id: "sess-alpha" },
    { project: "beta", session_id: "sess-beta" },
  ]);
});

// --- Session lọc theo project (Task 4) ---

test("session của project này không rò sang project khác", () => {
  createSession(910, "alpha", "sess-a", "phiên alpha");
  createSession(910, "beta", "sess-b", "phiên beta");

  expect(getActiveSession(910, "alpha")?.sessionId).toBe("sess-a");
  expect(getActiveSession(910, "beta")?.sessionId).toBe("sess-b");

  // Rời alpha rồi quay lại thì phiên vẫn còn nguyên
  clearActiveSession(910, "alpha");
  expect(getActiveSession(910, "alpha")).toBeNull();
  expect(getActiveSession(910, "beta")?.sessionId).toBe("sess-b");
});

test("getRecentSessions chỉ liệt kê phiên của project đang mở", () => {
  createSession(911, "gamma", "sess-g1", "g1");
  createSession(911, "delta", "sess-d1", "d1");

  const titles = getRecentSessions(911, "gamma").map((s) => s.title);
  expect(titles).toContain("g1");
  expect(titles).not.toContain("d1");
});

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

// --- Memory lọc theo project: fact chung theo anh khắp nơi, fact riêng ở đúng project ---

test("memory chung theo anh khắp nơi, memory riêng ở đúng project", () => {
  saveFact(920, "Anh dùng Bun thay Node", "preference", "test", null);
  saveFact(920, "Project alpha dùng Next.js 16", "stack", "test", "alpha");
  saveFact(920, "Project beta dùng Go", "stack", "test", "beta");

  const inAlpha = getUserFacts(920, 50, "alpha").map((f) => f.fact);
  expect(inAlpha).toContain("Anh dùng Bun thay Node");
  expect(inAlpha).toContain("Project alpha dùng Next.js 16");
  expect(inAlpha).not.toContain("Project beta dùng Go"); // không được rò

  const inBeta = getUserFacts(920, 50, "beta").map((f) => f.fact);
  expect(inBeta).toContain("Anh dùng Bun thay Node");
  expect(inBeta).not.toContain("Project alpha dùng Next.js 16");
});

test("searchFacts cũng chặn fact của project khác", () => {
  saveFact(921, "Alpha deploy bằng Vercel", "infra", "test", "alpha");
  saveFact(921, "Beta deploy bằng PM2", "infra", "test", "beta");

  const hits = searchFacts(921, "deploy", 20, "alpha").map((f) => f.fact);
  expect(hits).toContain("Alpha deploy bằng Vercel");
  expect(hits).not.toContain("Beta deploy bằng PM2");
});

test("getRelatedFacts không lộ quan hệ cũ trỏ sang fact của project khác", () => {
  // Chèn thẳng vào fact_relations (không qua embedAndLinkFact) để giả lập quan hệ
  // tạo TRƯỚC khi có fix — loại dữ liệu này vẫn tồn tại thật trong DB hiện tại,
  // getRelatedFacts phải tự lọc chứ không thể trông chờ dữ liệu luôn sạch.
  const alphaFact = saveFact(925, "Alpha: dùng Redis cache", "infra", "test", "alpha");
  const betaFact = saveFact(925, "Beta: dùng Redis cache", "infra", "test", "beta");
  linkFacts(alphaFact.id, betaFact.id, 0.9);

  const related = getRelatedFacts(alphaFact.id, 3, "alpha").map((r) => r.id);
  expect(related).not.toContain(betaFact.id);
});

test("getFactsByCategory chặn fact của project khác", () => {
  saveFact(926, "Alpha: convention naming camelCase", "convention", "test", "alpha");
  saveFact(926, "Beta: convention naming snake_case", "convention", "test", "beta");

  const inAlpha = getFactsByCategory(926, "convention", "alpha").map((f) => f.fact);
  expect(inAlpha).toContain("Alpha: convention naming camelCase");
  expect(inAlpha).not.toContain("Beta: convention naming snake_case");
});

test("saveFact chỉ nới rộng phạm vi fact, không âm thầm hạ fact chung xuống project", () => {
  // `project` do LLM đoán lại mỗi lần trích xuất, prompt còn dặn "không chắc thì
  // chọn project" — nên UPDATE không được tin giá trị mới một cách vô điều kiện.
  const userId = 927;
  const projectOf = (id: number) =>
    (db.query(`SELECT project FROM memory_facts WHERE id = ?`).get(id) as { project: string | null }).project;

  // 1. Fact CHUNG bị trích lại trong hội thoại của một project → phải giữ chung.
  //    Nếu bị hạ cấp, nó biến mất khỏi mọi project khác mà không có log nào.
  const chung = saveFact(userId, "Anh thích dùng Bun thay vì Node.js", "preference", "test", null);
  const lai = saveFact(userId, "Anh thích dùng Bun thay vì Node.js", "preference", "test", "funlife");
  expect(lai.id).toBe(chung.id); // vẫn 1 row, dedupe theo text không đổi
  expect(projectOf(chung.id)).toBeNull();
  expect(getUserFacts(userId, 50, "basotien").map((f) => f.fact)).toContain("Anh thích dùng Bun thay vì Node.js");

  // 2. Chiều NỚI RỘNG được phép: fact riêng lưu lại với scope global → nâng lên chung
  const rieng = saveFact(userId, "Anh dùng PM2 để chạy bot", "infra", "test", "my-assistant");
  expect(projectOf(rieng.id)).toBe("my-assistant");
  saveFact(userId, "Anh dùng PM2 để chạy bot", "infra", "test", null);
  expect(projectOf(rieng.id)).toBeNull();

  // 3. Nhảy ngang alpha → beta bị chặn: với người đang ở alpha thì đó cũng là mất fact
  const alpha = saveFact(userId, "Deploy bằng Docker Compose", "infra", "test", "alpha");
  saveFact(userId, "Deploy bằng Docker Compose", "infra", "test", "beta");
  expect(projectOf(alpha.id)).toBe("alpha");
  expect(getUserFacts(userId, 50, "alpha").map((f) => f.fact)).toContain("Deploy bằng Docker Compose");
});

test("countFacts chỉ đếm fact chung + fact của project đang mở", () => {
  const userId = 928;
  saveFact(userId, "Fact chung 1", "general", "test", null);
  saveFact(userId, "Alpha fact 1", "general", "test", "alpha");
  saveFact(userId, "Alpha fact 2", "general", "test", "alpha");
  saveFact(userId, "Beta fact 1", "general", "test", "beta");

  expect(countFacts(userId, "alpha")).toBe(3); // 1 chung + 2 alpha
  expect(countFacts(userId, "beta")).toBe(2); // 1 chung + 1 beta
});

test("memory tool dùng project đã chốt lúc tạo server, không tra lại giữa query", async () => {
  // `/p` không nằm trong lane queue → user đổi project được ngay giữa một query dài,
  // trong khi cwd + memory context của query đó đã chốt từ đầu. Tool phải đi theo
  // ngữ cảnh của query, không theo con trỏ project mới nhất.
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { createMemoryMcpServer } = await import("../src/mcp/memory.ts");

  const userId = 929;
  ensureProject("alpha");
  ensureProject("beta");
  setCurrentProject(userId, "alpha");

  // Server dựng lúc query bắt đầu — project đang mở khi đó là "alpha"
  const server = createMemoryMcpServer(userId, getCurrentProject(userId)) as unknown as { instance: any };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);

  try {
    // Giữa chừng anh Tuấn gõ /p beta
    setCurrentProject(userId, "beta");
    saveFact(userId, "Beta xài MySQL", "stack", "test", "beta");

    await client.callTool({
      name: "memory_save",
      arguments: { fact: "Alpha xài Postgres", category: "stack", scope: "project" },
    });

    const row = db
      .query(`SELECT project FROM memory_facts WHERE user_id = ? AND fact = ?`)
      .get(userId, "Alpha xài Postgres") as { project: string | null };
    expect(row.project).toBe("alpha");

    // memory_list cũng phải nhìn bằng con mắt của alpha — không lộ fact của beta
    const listed = (await client.callTool({ name: "memory_list", arguments: {} })) as {
      content: { text: string }[];
    };
    const text = listed.content.map((c) => c.text).join("");
    expect(text).toContain("Alpha xài Postgres");
    expect(text).not.toContain("Beta xài MySQL");
  } finally {
    await client.close();
  }
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
  expect(await loadConfigWith({ TELEGRAM_ALLOWED_USERS: "123", SESSION_TIMEOUT_HOURS: "nhiều" })).toBe(1);

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

// mock.module thay module toàn cục nên đặt sau test thật ở trên, và không test nào
// phía dưới còn cần embedding.ts/semantic.ts thật (đã kiểm — chỉ 2 test cuối file
// mock claude/provider.ts, agent-sdk, khác module).
test("embedAndLinkFact chỉ link fact cùng project hoặc fact chung — không link xuyên project", async () => {
  const userId = 924;
  // Vector giống hệt nhau cho mọi fact → cosine similarity luôn = 1, chắc chắn vượt
  // RELATION_THRESHOLD (0.75) bất kể nội dung text, để test không phụ thuộc vào
  // công thức similarity thật.
  const FAKE_VECTOR = [1, 0, 0];
  const realEmbedding = await import("../src/memory/embedding.ts");
  mock.module("../src/memory/embedding.ts", () => ({
    ...realEmbedding,
    getEmbeddingClient: () => ({
      embedBatch: async (texts: string[]) => texts.map(() => FAKE_VECTOR),
    }),
  }));

  const { embedAndLinkFact } = await import("../src/memory/semantic.ts");

  const global1 = saveFact(userId, "Anh thích code sạch", "preference", "test", null);
  await embedAndLinkFact(userId, global1.id, global1.fact, null);

  const beta1 = saveFact(userId, "Beta dùng MySQL", "stack", "test", "beta");
  await embedAndLinkFact(userId, beta1.id, beta1.fact, "beta");

  const alpha1 = saveFact(userId, "Alpha dùng Postgres", "stack", "test", "alpha");
  const alphaLinked = await embedAndLinkFact(userId, alpha1.id, alpha1.fact, "alpha");

  // Fact riêng của alpha: link được với fact chung, không link với fact của beta
  expect(alphaLinked.map((l) => l.id)).toContain(global1.id);
  expect(alphaLinked.map((l) => l.id)).not.toContain(beta1.id);

  // Fact chung: chỉ link với fact chung, không tự link ngược vào alpha/beta
  const global2 = saveFact(userId, "Anh thích ngủ sớm", "personal", "test", null);
  const globalLinked = await embedAndLinkFact(userId, global2.id, global2.fact, null);
  expect(globalLinked.map((l) => l.id)).toContain(global1.id);
  expect(globalLinked.map((l) => l.id)).not.toContain(alpha1.id);
  expect(globalLinked.map((l) => l.id)).not.toContain(beta1.id);
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

// --- Footer: token thay cho danh sách tool ---

test("formatUsageTotal cộng cả cache vào tổng token", () => {
  expect(
    formatUsageTotal({
      inputTokens: 12_400,
      outputTokens: 8_200,
      cacheReadTokens: 220_000,
      cacheCreationTokens: 8_000,
      costUSD: 1.2,
    }),
  ).toBe("📊 248.6k tokens");
});

test("formatUsageTotal im lặng khi không có số liệu", () => {
  // query bị abort/lỗi → không có usage, footer chỉ còn thời gian
  expect(formatUsageTotal(undefined)).toBe("");

  // usage tồn tại nhưng rỗng → "0 tokens" vô nghĩa, cũng bỏ luôn
  expect(
    formatUsageTotal({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
    }),
  ).toBe("");
});

test("formatTokenCount rút gọn theo bậc nghìn/triệu", () => {
  expect(formatTokenCount(999)).toBe("999");
  expect(formatTokenCount(1_500)).toBe("1.5k");
  expect(formatTokenCount(2_500_000)).toBe("2.50M");
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

// --- Consolidation không được chạy lại mỗi lần restart ---

test("shouldConsolidateNow bỏ qua lần đầu và ghi mốc", () => {
  db.run(`DELETE FROM db_meta WHERE key = 'consolidation_last_run'`);

  // Chưa có mốc: nếu chạy luôn thì mỗi lần restart lại gộp một vòng,
  // memory teo theo số lần deploy (đo được: 51 → 26 fact trong một buổi chiều)
  expect(shouldConsolidateNow()).toBe(false);

  // ...nhưng phải ghi mốc, nếu không lần restart sau lại rơi vào đúng nhánh này
  const row = db.query(`SELECT value FROM db_meta WHERE key = 'consolidation_last_run'`).get() as
    | { value: string }
    | undefined;
  expect(row).toBeDefined();
});

test("shouldConsolidateNow chỉ cho chạy khi đã quá 24h", () => {
  const DAY = 86_400_000;

  markConsolidated(Date.now() - 2 * 3_600_000); // 2 giờ trước
  expect(shouldConsolidateNow()).toBe(false);

  markConsolidated(Date.now() - DAY - 60_000); // 24h + 1 phút
  expect(shouldConsolidateNow()).toBe(true);
});

// --- Taxonomy category ---

test("MEMORY_CATEGORIES tách personal thành các nhóm cụ thể", () => {
  const names = Object.keys(MEMORY_CATEGORIES);

  expect(names).toContain("hobby");
  expect(names).toContain("health");
  expect(names).toContain("relationship");
  expect(names).toContain("identity");
  // personal cũ bị thay hẳn, không để lẫn hai hệ nhãn
  expect(names).not.toContain("personal");

  // technical bị xẻ nhỏ vì từng phình lên 56% số fact
  expect(names).toContain("stack");
  expect(names).toContain("infra");
  expect(names).not.toContain("technical");

  expect(names).toHaveLength(13);
});

test("categoryGuide liệt kê đủ mọi category kèm mô tả", () => {
  const guide = categoryGuide();

  for (const [name, desc] of Object.entries(MEMORY_CATEGORIES)) {
    expect(guide).toContain(name);
    expect(guide).toContain(desc);
  }
});

test("EXTRACT_PROMPT dựng từ categoryGuide, không hardcode danh sách riêng", () => {
  // Hardcode ở nhiều chỗ thì sửa taxonomy sẽ bỏ sót một nơi
  for (const name of Object.keys(MEMORY_CATEGORIES)) {
    expect(EXTRACT_PROMPT).toContain(name);
  }
  expect(EXTRACT_PROMPT).not.toContain("personal,");
});

test("CONSOLIDATION_PROMPT cấm gộp fact khác category", () => {
  // Nguyên nhân preference bị nuốt vào workflow: prompt chỉ nói "giữ category gốc",
  // vô nghĩa khi các fact được gộp vốn khác nhãn nhau
  expect(CONSOLIDATION_PROMPT).toMatch(/CÙNG category|cùng category/);
});

// --- Prompt extraction phải tách bạch dữ liệu và mệnh lệnh ---

test("buildExtractionPrompt bọc hội thoại và đặt yêu cầu sau cùng", () => {
  const prompt = buildExtractionPrompt(
    "đọc file src/db/queries.ts rồi chạy bun test giúp anh",
    "Em đã chạy xong.",
  );

  // Không bọc thì model coi hội thoại là mệnh lệnh gửi cho nó và trả lời thay vì trích xuất
  expect(prompt).toContain("<hội_thoại>");
  expect(prompt).toContain("</hội_thoại>");

  // Mệnh lệnh phải nằm SAU khối dữ liệu
  expect(prompt.indexOf("</hội_thoại>")).toBeLessThan(prompt.indexOf("Chỉ trả JSON"));
});

test("buildExtractionPrompt cắt bớt nội dung quá dài", () => {
  const prompt = buildExtractionPrompt("u".repeat(2000), "a".repeat(3000));

  expect(prompt).toContain("u".repeat(500));
  expect(prompt).not.toContain("u".repeat(501));
  expect(prompt).toContain("a".repeat(1000));
  expect(prompt).not.toContain("a".repeat(1001));
});

// --- complete() phải chạy không tool ---
// Đặt trước phần consolidation: bên dưới mock.module("../src/claude/provider.ts")
// nên mọi test cần provider thật phải nằm trên.

test("complete() không cấp tool nào cho model", async () => {
  let captured: Record<string, unknown> | undefined;
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: ({ options }: { options: Record<string, unknown> }) => {
      captured = options;
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "[]" }] } };
      })();
    },
  }));

  const { ClaudeProvider } = await import("../src/claude/provider.ts");
  await new ClaudeProvider().complete({ prompt: "x", systemPrompt: "y" });

  // allowedTools chỉ là danh sách auto-approve — KHÔNG hạn chế gì.
  // Muốn model không có tool thì phải dùng `tools: []`, kèm chặn MCP từ config máy.
  expect(captured?.tools).toEqual([]);
  expect(captured?.strictMcpConfig).toBe(true);
  expect(captured?.maxTurns).toBe(1);
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

// --- /model: chọn model theo user ---

test("parseTier nhận cả tên model lẫn tên tier, không phân biệt hoa thường", () => {
  expect(parseTier("opus")).toBe("powerful");
  expect(parseTier("  SONNET ")).toBe("balanced");
  expect(parseTier("fast")).toBe("fast");
  expect(parseTier("gpt-4")).toBeNull();
  expect(parseTier("")).toBeNull();
});

test("tierOfModel trả null cho model lạ thay vì đoán bừa", () => {
  expect(tierOfModel(resolveModelTier("powerful"))).toBe("powerful");
  expect(tierOfModel("claude-tuy-bien-cua-anh")).toBeNull();
});

test("model của user lưu được, đọc lại đúng, xoá thì về rỗng", () => {
  expect(getUserModel(777)).toBe("");

  setUserModel(777, "claude-haiku-4-5");
  expect(getUserModel(777)).toBe("claude-haiku-4-5");

  // Chọn lại lần nữa phải ghi đè, không tạo dòng thứ hai
  setUserModel(777, "claude-opus-5");
  expect(getUserModel(777)).toBe("claude-opus-5");
  const count = db.query(`SELECT COUNT(*) as c FROM user_model WHERE user_id = ?`).get(777) as { c: number };
  expect(count.c).toBe(1);

  clearUserModel(777);
  expect(getUserModel(777)).toBe("");
});

test("model của user này không lẫn sang user khác", () => {
  setUserModel(801, "claude-haiku-4-5");
  expect(getUserModel(802)).toBe("");
  clearUserModel(801);
});

// --- /skills ---

test("formatSkillList báo rõ khi chưa có skill nào", () => {
  expect(formatSkillList([])).toContain("Chưa có skill");
});

test("formatSkillList liệt kê tên, dung lượng và mô tả", () => {
  const text = formatSkillList([
    { name: "godot", title: "Godot", description: "Scene & Node", filePath: "/x/godot.md", sizeBytes: 2048 },
  ]);
  expect(text).toContain("1 skill");
  expect(text).toContain("godot");
  expect(text).toContain("2.0 KB");
  expect(text).toContain("Scene & Node");
});

// --- Agent chạy trong thư mục của project ---

test("query() chạy trong thư mục của project đang mở", async () => {
  let captured: Record<string, unknown> | undefined;
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: ({ options }: { options: Record<string, unknown> }) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "ok", session_id: "s" };
      })();
    },
  }));

  const { ClaudeProvider } = await import("../src/claude/provider.ts");
  await new ClaudeProvider().query({ prompt: "x", userId: 1, cwd: "/tmp/duan" });

  expect(captured?.cwd).toBe("/tmp/duan");
});

// --- extractFacts: thiếu scope phải rơi vào project hiện tại, không thành fact chung ---
// Đặt cuối file, sau mọi test cần provider.ts thật.

test("fact thiếu scope rơi vào project hiện tại, không thành fact chung", async () => {
  // Model quên trả "scope" là chuyện thường. Mặc định phải là hẹp: một fact riêng
  // bị đánh dấu chung sẽ chen vào ngữ cảnh của MỌI project khác.
  mock.module("../src/claude/provider.ts", () => ({
    getClaudeProvider: () => ({
      complete: async () => JSON.stringify([{ fact: "Dự án này chạy trên Deno", category: "stack" }]),
    }),
  }));

  const { extractFacts } = await import("../src/memory/extraction.ts");
  await extractFacts(922, "mình dùng Deno cho dự án này nhé", "Vâng em ghi nhớ ạ", "gamma");

  const row = db
    .query(`SELECT project FROM memory_facts WHERE user_id = ? AND fact LIKE '%Deno%'`)
    .get(922) as { project: string | null } | undefined;

  expect(row?.project).toBe("gamma");
});
