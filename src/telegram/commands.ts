// src/telegram/commands.ts
// ============================================================
// Commands — Xử lý các lệnh Telegram
// ============================================================

import type { Context } from "grammy";
import { clearActiveSession, getActiveSession, getRecentSessions, setActiveSession } from "../db/sessions.ts";
import {
  ensureProject,
  getCurrentProject,
  listProjects,
  resolveProjectPath,
  setCurrentProject,
  type Project,
} from "../db/projects.ts";
import { getQueryStats, getUsageByPeriod, type PeriodUsage } from "../db/queries.ts";
import { clearUserModel, getUserModel, setUserModel } from "../db/user-model.ts";
import { deleteFact, getUserFacts, countFacts } from "../memory/repository.ts";
import { countDocuments } from "../memory/knowledge.ts";
import { countEntities } from "../memory/entities.ts";
import { formatTokenCount, splitMessage, timeAgo, TOOL_ICONS } from "./formatter.ts";
import { config } from "../config.ts";
import { getClaudeProvider } from "../claude/provider.ts";
import { getSkillCount, listSkillSummaries, type SkillMeta } from "../claude/skills.ts";
import { parseTier, resolveModelTier, tierOfModel, TIER_LABELS, type ModelTier } from "../claude/router.ts";
import { createNewsDigest } from "../scheduler/news-digest.ts";

// Bot start time — để tính uptime
const botStartTime = Date.now();

// --- Tracking active queries ---
// Map<userId, AbortController>
// Khi user gõ /stop, lấy controller ra và .abort()
export const activeQueries = new Map<number, AbortController>();

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
      `/p — Chuyển project\n` +
      `/new — Phiên hội thoại mới\n` +
      `/resume — Tiếp tục phiên cũ\n` +
      `/model — Đổi model AI\n` +
      `/stop — Dừng query đang chạy\n` +
      `/status — Xem trạng thái\n` +
      `/usage — Token đã dùng theo kỳ\n` +
      `/memory — Xem bộ nhớ dài hạn\n` +
      `/forget <id> — Xoá 1 fact khỏi bộ nhớ\n` +
      `/news — Tin công nghệ mới nhất\n` +
      `/skills — Skill đang load\n` +
      `/reload — Reload skills\n\n` +
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

/**
 * Dựng chuỗi danh sách project — tách riêng khỏi handler để test được
 * mà không cần giả lập Context của grammY.
 */
export function formatProjectList(
  projects: (Project & { sessionCount: number })[],
  current: string,
  // Tham số tuỳ chọn cho test hermetic (trỏ vào thư mục tạm) — mặc định dùng
  // đúng baseDir thật mà agent chạy.
  baseDir: string = config.claudeWorkingDir,
): string {
  if (projects.length === 0) {
    return "📁 Chưa có project nào.\n\nGõ `/p <tên>` để tạo, ví dụ: `/p my-assistant`";
  }

  const lines = projects.map((p) => {
    const mark = p.name === current ? "▸" : " ";
    // Không được check theo `p.path` đã lưu trong registry: khi project được tạo
    // TRƯỚC KHI thư mục riêng từng tồn tại, ensureProject lưu path = baseDir (giá
    // trị fallback) — baseDir luôn có thật nên check kiểu đó luôn ra "còn tồn tại"
    // dù project chưa từng có thư mục riêng. Phân giải lại từ TÊN + baseDir hiện
    // tại thì đúng cho cả 2 trường hợp: chưa từng có thư mục, và có rồi bị xoá.
    const warn = resolveProjectPath(p.name, baseDir).exists ? "" : " ⚠️";
    return `${mark} ${p.name} — ${p.sessionCount} phiên · ${timeAgo(p.lastUsedAt)}${warn}`;
  });
  return `📁 Project đang có:\n${lines.join("\n")}`;
}

/**
 * /p — xem danh sách project; /p <tên> — chuyển (tạo nếu chưa có)
 */
export async function handleProject(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const arg = (ctx.match as string | undefined)?.trim() ?? "";

  if (!arg) {
    await ctx.reply(formatProjectList(listProjects(), getCurrentProject(userId)));
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

  const { exists } = resolveProjectPath(project.name);
  const session = getActiveSession(userId, project.name);

  let text = created ? `✅ Tạo project ${project.name}` : `✅ Đã chuyển sang ${project.name}`;
  text += `\n📂 ${project.path}`;
  if (!exists) text += `\n⚠️ Không thấy thư mục riêng — dùng thư mục gốc`;
  if (session) text += `\n📝 Tiếp phiên: "${session.title}"`;

  await ctx.reply(text);
}

/**
 * /status — Xem trạng thái + thống kê (gộp /stats)
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const isProcessing = activeQueries.has(userId);
  const project = getCurrentProject(userId);
  const session = getActiveSession(userId, project);
  const uptime = formatUptime(Date.now() - botStartTime);

  const statusText = isProcessing
    ? "⏳ Đang xử lý query..."
    : "✅ Sẵn sàng nhận lệnh";

  const sessionInfo = session
    ? `📝 Session: ${session.title}\n   Tạo: ${timeAgo(session.createdAt)}`
    : "📝 Session: không có (gửi tin nhắn để tạo mới)";

  // project rỗng nghĩa là chưa /p lần nào — agent vẫn chạy ở thư mục gốc như trước đây
  const projectInfo = project ? `📁 Project: ${project}` : "📁 Project: (chưa chọn)";

  // Skills count (từ cache, không đọc disk)
  const skillInfo = `📚 Skills: ${getSkillCount()} loaded`;

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
      `${projectInfo}\n` +
      `${skillInfo}\n\n` +
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
 * /reload — Reload skills mà không cần restart bot
 */
export async function handleReload(ctx: Context): Promise<void> {
  getClaudeProvider().reloadSkills();
  await ctx.reply("🔄 Skills đã được reload! Thay đổi sẽ có hiệu lực từ tin nhắn tiếp theo.");
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

/** Dựng chuỗi danh sách skill — tách riêng để test không cần Context của grammY */
export function formatSkillList(skills: SkillMeta[]): string {
  if (skills.length === 0) {
    return "📚 Chưa có skill nào trong thư mục `skills/`.";
  }

  const lines = skills.map((s) => {
    const kb = (s.sizeBytes / 1024).toFixed(1);
    const desc = s.description ? `\n   ${s.description}` : "";
    return `• ${s.name} (${kb} KB)${desc}`;
  });
  return `📚 ${skills.length} skill đang load:\n\n${lines.join("\n")}`;
}

/**
 * /skills — Xem danh sách skill đang load
 */
export async function handleSkills(ctx: Context): Promise<void> {
  const skills = await listSkillSummaries();
  for (const part of splitMessage(formatSkillList(skills))) {
    await ctx.reply(part);
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

  // deleteFact lọc theo user_id nên không xoá được fact của người khác
  const deleted = deleteFact(userId, id);
  await ctx.reply(deleted ? `✅ Đã xoá fact #${id}` : `❌ Không tìm thấy fact #${id}`);
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

/**
 * /stop — Dừng query đang chạy
 *
 * Lấy AbortController của user từ activeQueries
 * và gọi .abort() để hủy request tới Claude.
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;

  const controller = activeQueries.get(userId);
  if (controller) {
    controller.abort();
    activeQueries.delete(userId);
    await ctx.reply("⏹ Đã dừng query.");
  } else {
    await ctx.reply("ℹ️ Không có query nào đang chạy.");
  }
}

