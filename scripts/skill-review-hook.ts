#!/usr/bin/env bun
// scripts/skill-review-hook.ts
// ============================================================
// Stop hook — cho phiên Claude Code CLI tự rút skill như bot Telegram
// ============================================================
//
// Bot Telegram đã có vòng self-improvement (src/memory/skill-review.ts): cứ 15 lượt
// thì fork phiên vừa xong và hỏi "có gì đáng ghi vào skill không?". Phiên Claude
// Code CLI thì không — nó chỉ ĐỌC skill bot đã sinh. Script này nối nốt chiều còn
// lại, dùng lại nguyên `reviewSkills()`.
//
// Chạy được là nhờ một điều đã kiểm chứng bằng tay: Agent SDK fork được transcript
// do Claude Code CLI ghi (`resume: <session_id>` + `forkSession: true`, cùng `cwd`).
// Nên không cần đọc/parse `~/.claude/projects/<slug>/*.jsonl` — chỉ cần chuyển
// `session_id` từ hook input sang thẳng SDK.
//
// Hai chế độ trong một file:
//   (mặc định) HOOK  — đọc JSON hook trên stdin, đếm lượt, tới ngưỡng thì đẻ tiến
//                      trình nền rồi THOÁT NGAY. Claude Code chặn chờ Stop hook,
//                      nên mọi mili-giây ở đây là thời gian anh Tuấn ngồi nhìn.
//   --run            — tiến trình nền thật: giữ lock, gọi reviewSkills, ghi log.
// ============================================================

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, writeSync, unlinkSync, appendFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

/** Thư mục gốc project — tính theo vị trí file, KHÔNG theo cwd: hook chạy với cwd
 * của repo anh Tuấn đang mở (funlife, vnarena...), không phải my-assistant. */
const PROJECT_DIR = resolve(import.meta.dir, "..");
const LOG_FILE = resolve(homedir(), ".claude", "skill-review.log");
const LOCK_FILE = resolve(homedir(), ".claude", "skill-review.lock");

// --- Logic thuần (test được, không đụng I/O ngoài) ---

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

export function parseHookPayload(raw: string): HookPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Có nên chạy review cho lượt này không.
 *
 * Cửa quan trọng nhất là `CLAUDE_CODE_ENTRYPOINT`. Agent SDK để trống
 * `settingSources` nghĩa là nạp HẾT settings ("When omitted, all sources are
 * loaded") — kể cả `~/.claude/settings.json` nơi hook này được khai báo. Không
 * chặn thì: mỗi lượt bot Telegram trả lời cũng gọi hook (đếm trùng với cơ chế
 * riêng của bot), và tệ hơn, chính fork review lại đẻ ra một fork review nữa.
 * SDK tự đặt entrypoint là `sdk-ts`/`sdk-py`, CLI thật là `cli`.
 *
 * Chặn theo tiền tố "sdk" thay vì chỉ cho qua đúng chuỗi "cli": nếu bản Claude
 * Code sau đổi tên entrypoint (`vscode`, `desktop`...) thì tính năng vẫn sống,
 * còn đường đệ quy vẫn khoá.
 */
export function shouldReview(
  env: Record<string, string | undefined>,
  payload: HookPayload,
  dirExists: (path: string) => boolean = existsSync,
): { run: boolean; reason: string } {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  if (entrypoint.startsWith("sdk")) {
    return { run: false, reason: `phiên SDK (${entrypoint}) — bot hoặc chính fork review` };
  }
  if (env.KURO_SKILL_REVIEW === "1") {
    return { run: false, reason: "đang ở bên trong tiến trình review" };
  }
  if (payload.stop_hook_active) {
    return { run: false, reason: "stop_hook_active — lượt này do hook kích, không phải anh Tuấn" };
  }
  if (!payload.session_id) {
    return { run: false, reason: "thiếu session_id — không có transcript để fork" };
  }
  if (payload.cwd && !dirExists(payload.cwd)) {
    return { run: false, reason: `thư mục phiên không còn: ${payload.cwd}` };
  }
  return { run: true, reason: "ok" };
}

/**
 * Giành quyền chạy review. Trả `false` khi lượt trước còn đang chạy.
 *
 * `openSync(path, "wx")` là bước atomic: hai tiến trình cùng tới ngưỡng thì chỉ
 * một cái tạo được file. Nhánh cướp lock quá hạn là để một lần crash giữa chừng
 * không giết tính năng vĩnh viễn — lock rác không ai dọn sẽ chặn mọi lượt sau.
 */
export function acquireLock(path: string, ttlMs: number, now: number = Date.now()): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(now));
    closeSync(fd);
    return true;
  } catch {
    try {
      const startedAt = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(startedAt) && now - startedAt >= ttlMs) {
        writeFileSync(path, String(now));
        return true;
      }
    } catch {
      // lock hỏng/không đọc được → coi như đang có người giữ, lượt sau tính tiếp
    }
    return false;
  }
}

// --- I/O ---

function log(line: string): void {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // log hỏng thì thôi, không được làm chết phiên của anh Tuấn
  }
}

/**
 * Nạp `.env` của my-assistant vào process.
 *
 * Bắt buộc, không phải cho tiện: `src/config.ts` gọi `requireEnv("TELEGRAM_BOT_TOKEN")`
 * và `process.exit(1)` nếu thiếu. Hook chạy với cwd của repo khác nên Bun không tự
 * nạp .env này — thiếu bước đây thì hook chết với exit code 1 và Claude Code báo
 * lỗi hook đỏ lòm sau mỗi lượt trả lời.
 *
 * Không ghi đè biến đã có sẵn trong env.
 */
function loadProjectEnv(): void {
  const file = resolve(PROJECT_DIR, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

async function readStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}

/** Chế độ hook: nhanh nhất có thể, mọi việc nặng đẩy sang tiến trình nền. */
async function runHook(): Promise<void> {
  const payload = parseHookPayload(await readStdin()) ?? {};
  const decision = shouldReview(process.env, payload);
  if (!decision.run) return;

  loadProjectEnv();
  const [{ noteTurn }, { config }] = await Promise.all([
    import("../src/memory/turn-counter.ts"),
    import("../src/config.ts"),
  ]);
  // Kiểm trước khi đếm: tắt bằng SKILL_REVIEW=0 thì hook phải là no-op hoàn toàn,
  // không đẻ tiến trình nền chỉ để nó tự thoát.
  if (!config.skillReviewEnabled) return;

  const project = payload.cwd || PROJECT_DIR;
  if (!noteTurn("cc", project)) return;

  // Tách hẳn tiến trình: Claude Code chờ Stop hook kết thúc, mà review tốn tới
  // 5 phút. stdout/stderr đổ thẳng vào log để giữ luôn dòng logger của reviewSkills.
  const logFd = openSync(LOG_FILE, "a");
  const child = Bun.spawn({
    cmd: [process.execPath, "run", import.meta.path, "--run", payload.session_id!, project],
    cwd: PROJECT_DIR,
    env: { ...process.env, KURO_SKILL_REVIEW: "1" },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  child.unref();
  log(`▶️ Tới ngưỡng ở ${project} — chạy review nền (session ${payload.session_id})`);
}

/** Chế độ nền: chạy thật, không ai chờ. */
async function runReview(sessionId: string, project: string): Promise<void> {
  loadProjectEnv();
  const { config } = await import("../src/config.ts");

  if (!acquireLock(LOCK_FILE, config.skillReviewTimeoutMs)) {
    log("⏭️ Bỏ qua: lượt review trước còn đang chạy");
    return;
  }

  try {
    const { reviewSkills } = await import("../src/memory/skill-review.ts");
    await reviewSkills({
      userId: "cc",
      sessionId,
      project,
      cwd: project,
      onLearned: (summary) => log(`🎓 Học được: ${summary}`),
    });
  } catch (error) {
    log(`⚠️ Lỗi: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // lock đã bị lượt khác cướp — không phải lỗi
    }
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--run") {
    await runReview(process.argv[3] ?? "", process.argv[4] ?? "");
  } else {
    await runHook();
  }
}
