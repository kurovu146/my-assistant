// src/telegram/commands.ts
// ============================================================
// Commands — Xử lý các lệnh Telegram
// ============================================================

import type { Context } from "grammy";
import { clearActiveSession, getActiveSession, getRecentSessions, setActiveSession } from "../db/sessions.ts";
import {
  clearCurrentProject,
  ensureProject,
  getCurrentProject,
  listProjects,
  normalizeProjectName,
  resolveProjectPath,
  setCurrentProject,
  type Project,
} from "../db/projects.ts";
import { isQueryActive, listRunning, stopAllQueries, stopQuery } from "./lanes.ts";
import { getQueryStats, getUsageByPeriod, type PeriodUsage } from "../db/queries.ts";
import { clearUserModel, getUserModel, setUserModel } from "../db/user-model.ts";
import { deleteFact, getFactById, getUserFacts, countFacts } from "../memory/repository.ts";
import { countDocuments } from "../memory/knowledge.ts";
import { countEntities } from "../memory/entities.ts";
import { formatTokenCount, splitMessage, timeAgo, TOOL_ICONS } from "./formatter.ts";
import { config } from "../config.ts";
import { parseTier, resolveModelTier, tierOfModel, TIER_LABELS, type ModelTier } from "../claude/router.ts";
import { createNewsDigest } from "../scheduler/news-digest.ts";

// Bot start time — để tính uptime
const botStartTime = Date.now();

// Sổ query đang chạy nằm ở lanes.ts — khoá theo (user, project) chứ không theo
// mỗi user nữa, vì nhiều project chạy song song được.

/**
 * /start — Chào mừng và hướng dẫn sử dụng
 * Gọi khi user nhắn bot lần đầu tiên.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const name = ctx.from?.first_name || "bạn";

  await ctx.reply(
    `👋 Xin chào ${name}!\n\n` +
      `Tôi là trợ lý AI cá nhân, sẵn sàng giúp bạn:\n\n` +
      `💻 Lập trình — review code, debug, viết code\n` +
      `🔍 Nghiên cứu — tìm kiếm, tổng hợp thông tin\n` +
      `📁 File — đọc, phân tích file bạn gửi\n\n` +
      `Lệnh:\n` +
      `/p — Chuyển project (việc cũ vẫn chạy nền)\n` +
      `/new — Phiên hội thoại mới\n` +
      `/resume — Tiếp tục phiên cũ\n` +
      `/model — Đổi model AI\n` +
      `/stop [tên|all] — Dừng query đang chạy\n` +
      `/status — Xem trạng thái\n` +
      `/usage — Token đã dùng theo kỳ\n` +
      `/memory — Xem bộ nhớ dài hạn\n` +
      `/forget <id> — Xoá 1 fact khỏi bộ nhớ\n` +
      `/news — Tin công nghệ mới nhất\n\n` +
      `Gửi tin nhắn bất kỳ để bắt đầu! 🚀`,
  );
}

/**
 * /new — Bắt đầu phiên hội thoại mới
 *
 * Xóa active session → lần nhắn tiếp sẽ tạo phiên mới.
 * Session cũ vẫn còn trong DB, có thể /resume sau.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const project = getCurrentProject(userId);
  clearActiveSession(userId, project);
  await ctx.reply("🆕 Đã tạo phiên mới. Gửi tin nhắn để bắt đầu!");
}

/**
 * /resume — Hiển thị danh sách phiên cũ để chọn tiếp tục
 *
 * Hiện 5 phiên gần nhất dưới dạng inline keyboard.
 * User bấm vào phiên nào → handleResumeCallback() xử lý.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const project = getCurrentProject(userId);
  const sessions = getRecentSessions(userId, project);

  if (sessions.length === 0) {
    await ctx.reply("📭 Chưa có phiên nào. Gửi tin nhắn để bắt đầu!");
    return;
  }

  // Tạo inline keyboard — mỗi session là 1 nút bấm
  const keyboard = sessions.map((session) => [
    {
      text: `📝 ${session.title} (${timeAgo(session.lastActiveAt)})`,
      callback_data: `resume:${session.sessionId}`,
    },
  ]);

  await ctx.reply("📋 Chọn phiên để tiếp tục:", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Xử lý khi user bấm nút chọn session từ /resume
 *
 * callback_data có dạng "resume:session-id-xxx"
 * → Tách lấy sessionId → setActiveSession()
 */
export async function handleResumeCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  // Lấy callback data từ nút bấm
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("resume:")) return;

  // Tách session ID
  const sessionId = data.replace("resume:", "");
  const project = getCurrentProject(userId);
  setActiveSession(userId, project, sessionId);

  // Trả lời callback (xóa loading spinner trên nút)
  await ctx.answerCallbackQuery({ text: "✅ Đã resume phiên" });
  await ctx.reply("🔄 Đã tiếp tục phiên trước. Gửi tin nhắn để tiếp!");
}

/** Đối số của /p mang nghĩa "thoát project, về trò chuyện chung". */
const EXIT_PROJECT_ARGS = new Set(["-", "none", "chung", "reset"]);

/** Tiền tố callback_data của nút chọn project. */
const PROJECT_CALLBACK_PREFIX = "proj:";

/** Bấm hết một màn hình điện thoại là quá đủ; còn lại gõ `/p <tên>`. */
const MAX_PROJECT_BUTTONS = 12;

/**
 * `callback_data` của Telegram tối đa 64 **byte**, mà tên project được phép dài
 * 64 ký tự — cộng tiền tố là tràn. Trả null khi không nhét vừa, caller bỏ nút đó
 * đi (vẫn chuyển được bằng `/p <tên>`).
 */
export function projectCallbackData(name: string): string | null {
  const data = PROJECT_CALLBACK_PREFIX + name;
  return Buffer.byteLength(data, "utf8") <= 64 ? data : null;
}

/**
 * Nhãn một project trên nút bấm.
 *
 * ⚠️ = thư mục làm việc đã chốt (`p.path`, chính là cwd của agent) không còn khớp
 * với thư mục riêng của project trên đĩa. Hai trường hợp đều phải bắt:
 *   1. Chốt vào baseDir vì lúc tạo project chưa có thư mục riêng — kể cả khi thư
 *      mục đó xuất hiện sau, cwd vẫn giữ nguyên (cố ý: đổi cwd giết phiên). Check
 *      theo `p.path` đơn thuần lọt case này vì baseDir luôn tồn tại.
 *   2. Thư mục đã chốt bị xoá sau đó.
 */
export function projectButtonLabel(
  p: Project & { sessionCount: number },
  current: string,
  running: Set<string>,
  // Tham số tuỳ chọn cho test hermetic (trỏ vào thư mục tạm) — mặc định dùng
  // đúng baseDir thật mà agent chạy.
  baseDir: string = config.claudeWorkingDir,
): string {
  const mark = p.name === current ? "▸ " : "";
  const busy = running.has(p.name) ? " ⏳" : "";
  const own = resolveProjectPath(p.name, baseDir);
  const warn = own.exists && own.path === p.path ? "" : " ⚠️";
  return `${mark}${p.name} · ${p.sessionCount} phiên · ${timeAgo(p.lastUsedAt)}${busy}${warn}`;
}

/**
 * Dòng đầu của bảng chọn project.
 *
 * Luôn nói thẳng đang đứng ở đâu: bàn phím không có nút nào mang dấu ▸ khi anh ở
 * ngoài project, nhìn vào không biết mình đang ở đâu nếu header im lặng.
 */
export function buildProjectHeader(current: string, runningCount: number, hiddenCount: number): string {
  let header = `📁 Đang ở: ${current || "(không project)"}`;
  if (runningCount > 0) header += `\n⏳ = đang chạy (vẫn chạy tiếp khi anh /p đi chỗ khác)`;
  if (hiddenCount > 0) header += `\n… và ${hiddenCount} project cũ hơn — gõ /p <tên> để tới`;
  return header;
}

/**
 * Dựng bàn phím chọn project — tách riêng khỏi handler để test được mà không cần
 * giả lập Context của grammY. Mỗi project một hàng cho dễ bấm trên điện thoại.
 */
export function buildProjectKeyboard(
  projects: (Project & { sessionCount: number })[],
  current: string,
  running: Set<string> = new Set(),
  baseDir: string = config.claudeWorkingDir,
): { text: string; callback_data: string }[][] {
  const rows = projects
    .slice(0, MAX_PROJECT_BUTTONS)
    .map((p) => ({ p, data: projectCallbackData(p.name) }))
    .filter((x): x is { p: (typeof projects)[number]; data: string } => x.data !== null)
    .map(({ p, data }) => [{ text: projectButtonLabel(p, current, running, baseDir), callback_data: data }]);

  // Chỉ có đường ra khi đang ở trong một project nào đó.
  if (current) {
    rows.push([{ text: "🏠 Thoát project (trò chuyện chung)", callback_data: `${PROJECT_CALLBACK_PREFIX}-` }]);
  }
  return rows;
}

/**
 * /p — hiện danh sách project dạng nút bấm
 * /p <tên> — chuyển thẳng, tạo mới nếu chưa có
 * /p -     — thoát project, về trò chuyện chung
 */
export async function handleProject(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const arg = (ctx.match as string | undefined)?.trim() ?? "";
  if (arg) {
    await switchProject(ctx, userId, arg);
    return;
  }

  const projects = listProjects();
  if (projects.length === 0) {
    await ctx.reply("📁 Chưa có project nào.\n\nGõ `/p <tên>` để tạo, ví dụ: `/p my-assistant`", {
      parse_mode: "Markdown",
    });
    return;
  }

  const current = getCurrentProject(userId);
  const running = new Set(listRunning(userId).map((r) => r.project));
  const keyboard = buildProjectKeyboard(projects, current, running);
  // Nút chỉ hiện MAX_PROJECT_BUTTONS project gần nhất — phần đuôi vẫn gõ tay được.
  const hidden = Math.max(0, projects.length - MAX_PROJECT_BUTTONS);

  await ctx.reply(`${buildProjectHeader(current, running.size, hidden)}\n\nChọn project:`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/** Xử lý khi anh bấm nút project từ /p */
export async function handleProjectCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(PROJECT_CALLBACK_PREFIX)) return;

  const name = data.slice(PROJECT_CALLBACK_PREFIX.length);
  // Trả lời callback trước để nút hết quay, kể cả khi switchProject mất vài giây.
  await ctx.answerCallbackQuery();
  await switchProject(ctx, userId, name);
}

/**
 * Chuyển sang project (tạo nếu chưa có), hoặc thoát project khi `arg` là "-".
 * Dùng chung cho `/p <tên>` và nút bấm — hai đường vào phải cho ra đúng một hành vi.
 */
async function switchProject(ctx: Context, userId: number, arg: string): Promise<void> {
  if (EXIT_PROJECT_ARGS.has(arg.toLowerCase())) {
    clearCurrentProject(userId);
    await ctx.reply(
      `✅ Đã thoát project\n📂 ${config.claudeWorkingDir}\n` +
        `💭 Trò chuyện chung — fact mới sẽ dùng được ở mọi project`,
    );
    return;
  }

  const result = ensureProject(arg);
  if (!result) {
    // Tên không hợp lệ → từ chối và giữ nguyên project hiện tại, không được
    // âm thầm bỏ qua rồi vẫn coi như đã chuyển (tên này sẽ đi thẳng vào cwd của agent).
    await ctx.reply("❌ Tên project không hợp lệ. Chỉ dùng chữ thường, số, `.`, `_`, `-` (tối đa 64 ký tự).");
    return;
  }

  const { project, created } = result;
  setCurrentProject(userId, project.name);

  const own = resolveProjectPath(project.name);
  const session = getActiveSession(userId, project.name);

  let text = created ? `✅ Tạo project ${project.name}` : `✅ Đã chuyển sang ${project.name}`;
  text += `\n📂 ${project.path}`;
  // project.path là cwd thật và đã chốt từ lúc tạo — nói rõ để anh không tưởng
  // rằng cứ mkdir sau là agent tự nhảy vào thư mục đó (cố ý không nhảy: đổi cwd
  // làm SDK mất transcript của phiên đang chạy).
  if (project.path === config.claudeWorkingDir) {
    text += own.exists
      ? `\n⚠️ Đã có ${own.path} nhưng project chốt ở thư mục gốc từ lúc tạo`
      : `\n⚠️ Không thấy thư mục riêng — chốt dùng thư mục gốc`;
  } else if (!own.exists) {
    text += `\n⚠️ Thư mục đã chốt không còn tồn tại`;
  }
  if (session) text += `\n📝 Tiếp phiên: "${session.title}"`;
  // Chuyển project không giết việc đang chạy — nói ra để anh biết nó vẫn sống,
  // và biết đường quay lại xem thay vì tưởng đã mất.
  if (isQueryActive(userId, project.name)) text += `\n⏳ Project này đang có việc chạy dở`;

  const elsewhere = listRunning(userId).filter((r) => r.project !== project.name);
  if (elsewhere.length > 0) {
    text += `\n🏃 Vẫn chạy nền: ${elsewhere.map((r) => projectLabel(r.project)).join(", ")}`;
  }

  await ctx.reply(text);
}

/**
 * /status — Xem trạng thái + thống kê (gộp /stats)
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const project = getCurrentProject(userId);
  const session = getActiveSession(userId, project);
  const uptime = formatUptime(Date.now() - botStartTime);

  // Lane xếp hàng chờ slot cũng nằm trong sổ — tách ra, nếu không /status hiện
  // những câu vô nghĩa kiểu "Đang chạy 5/3".
  const active = listRunning(userId).filter((r) => !r.waiting);
  const queued = listRunning(userId).filter((r) => r.waiting);

  const statusLines: string[] = [];
  if (active.length > 0) {
    statusLines.push(`🏃 Đang chạy ${active.length}/${config.maxConcurrentProjects}:`);
    for (const r of active) {
      statusLines.push(`   • ${projectLabel(r.project)} — ${Math.round((Date.now() - r.startedAt) / 1000)}s`);
    }
  }
  if (queued.length > 0) {
    statusLines.push(`⏳ Chờ tới lượt: ${queued.map((r) => projectLabel(r.project)).join(", ")}`);
  }
  const statusText = statusLines.length > 0 ? statusLines.join("\n") : "✅ Sẵn sàng nhận lệnh";

  const sessionInfo = session
    ? `📝 Session: ${session.title}\n   Tạo: ${timeAgo(session.createdAt)}`
    : "📝 Session: không có (gửi tin nhắn để tạo mới)";

  // project rỗng nghĩa là chưa /p lần nào — agent vẫn chạy ở thư mục gốc như trước đây
  const projectInfo = project ? `📁 Project: ${project}` : "📁 Project: (chưa chọn)";

  // Query analytics (persistent — từ SQLite)
  const stats = getQueryStats(userId);
  let statsInfo: string;
  if (stats.totalQueries > 0) {
    const avgSec = (stats.avgResponseMs / 1000).toFixed(1);
    const topToolsStr = stats.topTools.length > 0
      ? stats.topTools
          .slice(0, 3)
          .map((t) => `${TOOL_ICONS[t.name] || "🔧"}${t.name}(${t.count})`)
          .join("  ")
      : "chưa có";

    statsInfo =
      `📈 Analytics (tích lũy):\n` +
      `   Queries: ${stats.totalQueries} (hôm nay: ${stats.todayQueries})\n` +
      `   Tokens: ${formatTokenCount(stats.totalTokensIn)} in / ${formatTokenCount(stats.totalTokensOut)} out\n` +
      `   Cost: $${stats.totalCostUsd.toFixed(4)}\n` +
      `   TB: ${avgSec}s/query\n` +
      `   Top tools: ${topToolsStr}`;
  } else {
    statsInfo = `📈 Analytics: chưa có query nào`;
  }

  await ctx.reply(
    `📊 Trạng thái\n\n` +
      `${statusText}\n` +
      `⏱ Uptime: ${uptime}\n\n` +
      `🤖 Model: ${describeModel(userId)}\n` +
      `🔑 Auth: ${config.authMode}\n` +
      `${projectInfo}\n\n` +
      `${statsInfo}\n\n` +
      `${sessionInfo}`,
  );
}

/**
 * Model đang áp dụng cho user + nguồn của nó (đã chọn qua /model hay mặc định).
 * Dùng chung cho /status và /model.
 */
function describeModel(userId: number): string {
  const chosen = getUserModel(userId);
  const model = chosen || config.claudeModel;
  const tier = tierOfModel(model);
  const label = tier ? ` — ${TIER_LABELS[tier]}` : "";
  return `${model}${label}${chosen ? "" : " (mặc định)"}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * /usage — Token đã dùng theo 3 khung rolling: hôm nay, 7 ngày, 30 ngày
 */
export async function handleUsage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const report = getUsageByPeriod(userId);

  // Retention xóa log quá 90 ngày, nên khung 30 ngày rỗng nghĩa là chưa dùng gì gần đây
  if (report.month.queries === 0) {
    await ctx.reply("📊 Chưa có dữ liệu usage trong 30 ngày qua. Gửi vài tin nhắn rồi quay lại nhé!");
    return;
  }

  // Tự ghép thay vì toLocaleDateString: dấu phân cách đổi theo bản ICU của môi trường
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const modelLines = report.byModel
    .map((m) => `   ${m.model.replace(/^claude-/, "")} — ${m.queries} query · $${m.costUsd.toFixed(2)}`)
    .join("\n");

  await ctx.reply(
    `📊 Token usage\n\n` +
      `📅 Hôm nay (${today})\n${formatPeriod(report.today)}\n\n` +
      `📆 7 ngày qua\n${formatPeriod(report.week)}\n\n` +
      `🗓 30 ngày qua\n${formatPeriod(report.month)}\n\n` +
      `🤖 Theo model (30 ngày)\n${modelLines}`,
  );
}

function formatPeriod(p: PeriodUsage): string {
  return (
    `   ${p.queries} queries · ${formatTokenCount(p.tokensIn)} in · ${formatTokenCount(p.tokensOut)} out\n` +
    `   Cache: ${formatTokenCount(p.cacheRead)} read · ${formatTokenCount(p.cacheWrite)} write\n` +
    `   Quy đổi API: $${p.costUsd.toFixed(2)}`
  );
}

/**
 * /model — xem model đang dùng + nút đổi
 * /model opus|sonnet|haiku (hoặc fast|balanced|powerful) — đổi thẳng
 * /model reset — quay về model mặc định của config
 */
export async function handleModel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const arg = (ctx.match as string | undefined)?.trim().toLowerCase() ?? "";

  if (arg === "reset" || arg === "default") {
    clearUserModel(userId);
    await ctx.reply(`↩️ Đã bỏ lựa chọn riêng.\n🤖 Model: ${describeModel(userId)}`);
    return;
  }

  if (arg) {
    const tier = parseTier(arg);
    if (!tier) {
      await ctx.reply(
        "❌ Không nhận ra model này.\n\n" +
          "Dùng: `/model haiku` · `/model sonnet` · `/model opus`\n" +
          "Hoặc `/model reset` để về mặc định.",
        { parse_mode: "Markdown" },
      );
      return;
    }
    setUserModel(userId, resolveModelTier(tier));
    await ctx.reply(`✅ Đã đổi model.\n🤖 ${describeModel(userId)}`);
    return;
  }

  // Không tham số → menu nút bấm
  const tiers: ModelTier[] = ["fast", "balanced", "powerful"];
  await ctx.reply(`🤖 Model hiện tại: ${describeModel(userId)}\n\nChọn model mới:`, {
    reply_markup: {
      inline_keyboard: tiers.map((tier) => [
        { text: TIER_LABELS[tier], callback_data: `model:${tier}` },
      ]),
    },
  });
}

/** Xử lý khi user bấm nút model từ /model */
export async function handleModelCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("model:")) return;

  const tier = parseTier(data.replace("model:", ""));
  if (!tier) {
    await ctx.answerCallbackQuery({ text: "❌ Model không hợp lệ" });
    return;
  }

  setUserModel(userId, resolveModelTier(tier));
  await ctx.answerCallbackQuery({ text: "✅ Đã đổi model" });
  await ctx.reply(`🤖 ${describeModel(userId)}`);
}

/**
 * /news — Lấy digest tin công nghệ ngay, không đợi cron 8h sáng
 */
export async function handleNews(ctx: Context): Promise<void> {
  const msg = await ctx.reply("⏳ Đang lấy tin từ Hacker News + GitHub Trending...");

  try {
    const digest = await createNewsDigest();
    const parts = splitMessage(digest);
    // Phần đầu thay thế message "đang lấy tin", phần còn lại gửi tiếp
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, parts[0] ?? digest);
    for (const part of parts.slice(1)) {
      await ctx.reply(part);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ Lỗi lấy tin: ${errMsg}`);
  }
}

/**
 * /forget <id> — Xoá 1 fact khỏi bộ nhớ (id lấy từ /memory)
 */
export async function handleForget(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const arg = (ctx.match as string | undefined)?.trim() ?? "";
  const id = Number(arg);

  if (!arg || !Number.isInteger(id) || id <= 0) {
    await ctx.reply(
      "🗑 Cách dùng: `/forget <id>`\n\nID lấy từ `/memory` — ví dụ `/forget 42`.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Đọc trước khi xoá — id rộng hơn phạm vi /memory đang hiển thị trên màn hình
  // (project khác cũng gõ được), và fact_relations/memory_kb_links xoá theo CASCADE
  // nên không hoàn tác được. Echo nguyên văn để gõ nhầm số còn biết ngay mình vừa
  // mất gì, thay vì chỉ thấy "#42" trống không.
  const fact = getFactById(userId, id);
  // deleteFact lọc theo user_id nên không xoá được fact của người khác
  const deleted = deleteFact(userId, id);
  await ctx.reply(
    deleted && fact ? `✅ Đã xoá #${id}: "${fact.fact}"` : `❌ Không tìm thấy fact #${id}`,
  );
}

/**
 * /memory — Xem memory stats và danh sách facts đã ghi nhớ
 */
export async function handleMemory(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const currentProject = getCurrentProject(userId);
  const total = countFacts(userId, currentProject);
  const facts = getUserFacts(userId, 20, currentProject);
  const docs = countDocuments(userId);
  const entities = countEntities(userId);

  if (total === 0 && docs === 0) {
    await ctx.reply(
      "🧠 Memory: chưa có gì.\n\n" +
        "Em sẽ tự động ghi nhớ thông tin quan trọng từ các cuộc hội thoại, " +
        "hoặc anh có thể bảo em nhớ trực tiếp.",
    );
    return;
  }

  // Group by category
  const grouped = new Map<string, typeof facts>();
  for (const f of facts) {
    const list = grouped.get(f.category) || [];
    list.push(f);
    grouped.set(f.category, list);
  }

  const extra = [
    docs > 0 ? `📄 ${docs} tài liệu` : "",
    entities > 0 ? `🏷 ${entities} entity` : "",
  ].filter(Boolean);
  let text = `🧠 Memory: ${total} facts${extra.length ? ` · ${extra.join(" · ")}` : ""}\n`;
  for (const [category, categoryFacts] of grouped) {
    text += `\n📁 ${category} (${categoryFacts.length})\n`;
    for (const f of categoryFacts) {
      const date = new Date(f.updatedAt).toLocaleDateString("vi-VN");
      // #id để dùng với /forget
      text += `  • #${f.id} ${f.fact} (${date})\n`;
    }
  }

  if (total > 20) {
    text += `\n... và ${total - 20} facts khác`;
  }
  text += `\n\n🗑 Xoá 1 fact: /forget <id>`;

  // Danh sách 20 fact dễ vượt 4096 ký tự của Telegram
  for (const part of splitMessage(text)) {
    await ctx.reply(part);
  }
}

/** Tên project cho người đọc — chuỗi rỗng là "trò chuyện chung". */
function projectLabel(project: string): string {
  return project || "trò chuyện chung";
}

/** Đối số của /stop mang nghĩa "dừng hết". */
const STOP_ALL_ARGS = new Set(["all", "hết", "het", "tất cả", "tat ca"]);

/**
 * /stop — dừng query của project đang mở
 * /stop <tên> — dừng đúng project đó
 * /stop all — dừng hết
 *
 * Nhiều project chạy song song được nên "dừng query" đã hết là một hành động
 * không mơ hồ: không chỉ rõ thì chỉ dừng chỗ anh đang đứng, tuyệt đối không
 * quơ luôn việc của project khác.
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const arg = (ctx.match as string | undefined)?.trim().toLowerCase() ?? "";

  if (STOP_ALL_ARGS.has(arg)) {
    const stopped = stopAllQueries(userId);
    await ctx.reply(
      stopped.length > 0
        ? `⏹ Đã dừng ${stopped.length} query: ${stopped.map(projectLabel).join(", ")}`
        : "ℹ️ Không có query nào đang chạy.",
    );
    return;
  }

  // Không có đối số → project đang mở. Có đối số → đúng project đó (kể cả khi
  // anh đang đứng ở chỗ khác).
  let target: string;
  if (!arg) {
    target = getCurrentProject(userId);
  } else if (EXIT_PROJECT_ARGS.has(arg)) {
    target = "";
  } else {
    const name = normalizeProjectName(arg);
    if (name === null) {
      await ctx.reply("❌ Tên project không hợp lệ.\n\nDùng `/stop`, `/stop <tên>` hoặc `/stop all`.", {
        parse_mode: "Markdown",
      });
      return;
    }
    target = name;
  }

  if (stopQuery(userId, target)) {
    await ctx.reply(`⏹ Đã dừng query ở ${projectLabel(target)}.`);
    return;
  }

  // Không có gì để dừng ở đó — nhưng chỗ khác có thì phải nói ra, nếu không anh
  // tưởng đã dừng hết rồi mà quota vẫn cháy ngầm.
  const running = listRunning(userId);
  if (running.length === 0) {
    await ctx.reply("ℹ️ Không có query nào đang chạy.");
    return;
  }
  await ctx.reply(
    `ℹ️ ${projectLabel(target)} không chạy gì.\n\n` +
      `🏃 Đang chạy: ${running.map((r) => projectLabel(r.project)).join(", ")}\n` +
      `Dùng /stop <tên> hoặc /stop all.`,
  );
}

