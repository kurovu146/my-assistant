// src/memory/skill-review.ts
// ============================================================
// Background skill review — bot tự rút skill từ hội thoại vừa xong
// ============================================================
//
// Chép vòng self-improvement của NousResearch/hermes-agent
// (agent/background_review.py + agent/turn_finalizer.py:633): cứ N lượt một
// lần, fork phiên vừa kết thúc và hỏi "có gì đáng ghi vào skill không?".
//
// Lý do làm bằng nhịp cưỡng bức chứ không bằng một tool để agent tự gọi:
// query_logs đo được `memory_save` = 0/100 lượt — agent chưa một lần chủ động
// ghi nhớ, trong khi 227 fact đều do pipeline nền sinh ra. Thêm tool "hãy tự
// viết skill" thì tỉ lệ dùng cũng sẽ là 0.
//
// Ba việc Hermes phải tự code mà Agent SDK gánh hộ:
//   - Hermes fork AIAgent rồi kế thừa credential thủ công; ở đây
//     `forkSession: true` làm việc đó — và quan trọng hơn, fork KHÔNG ghi vào
//     transcript phiên chính, nên hội thoại của anh không bị chèn lượt review.
//   - Hermes whitelist tool ở tầng dispatch; ở đây cắt bằng `tools` (KHÔNG
//     phải `allowedTools` — cái đó chỉ auto-approve, không cấm được gì).
//   - Hermes chặn ghi đè skill người dùng bằng sidecar provenance; ở đây
//     `canUseTool` chặn theo đường dẫn + marker frontmatter.
// ============================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "os";
import { resolve, sep } from "path";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

// --- Hằng số ---

/**
 * Skill dùng ở mọi project — nay là thư mục `skills/` bên trong repo git `kuro`.
 *
 * Trước đây trỏ thẳng `~/.claude/skills`. Đổi 2026-08-28 khi 64 skill được gom vào plugin
 * `kuro@skills-dir`: repo git nằm ngay tại `~/.claude/skills/kuro`, nên skill fork review
 * sinh ra rơi thẳng vào version control — `git status` thấy ngay nó vừa sửa gì. Đây là lần
 * đầu tiên anh Tuấn ĐỌC được diff của những gì vòng tự học viết.
 *
 * Không sửa dòng này thì hỏng ÂM THẦM: fork vẫn chạy, log vẫn in "🎓 Học được", nhưng file
 * rơi ra ngoài repo; tệ hơn, bước "vá skill ô tổng có sẵn" glob một thư mục gần như rỗng nên
 * LUÔN TẠO MỚI thay vì vá, đẻ skill trùng chủ đề dần theo tuần.
 *
 * Ghi đè được bằng env `KURO_SKILLS_DIR` cho cả hai đường gọi: bot pm2 do Bun nạp .env theo
 * cwd, phiên Claude Code CLI do `loadProjectEnv()` trong scripts/skill-review-hook.ts tự parse.
 */
export const GLOBAL_SKILLS_DIR = resolve(
  process.env.KURO_SKILLS_DIR || resolve(homedir(), ".claude", "skills", "kuro", "skills"),
);

/**
 * Dấu provenance trong frontmatter SKILL.md.
 *
 * Skill anh Tuấn viết tay KHÔNG có dòng này, nên guard bên dưới từ chối mọi
 * lệnh ghi đè lên chúng. Tương ứng khái niệm "curator-managed" của Hermes:
 * fork chạy khi không có ai ngồi duyệt, nên nó chỉ được sửa thứ do chính nó đẻ ra.
 */
export const PROVENANCE_MARKER = "generated_by: kuro-review";

/** Bộ tool tối thiểu để đọc hội thoại + ghi SKILL.md. Không Bash, không mạng, không Task. */
const REVIEW_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

/** Đai an toàn thứ hai: kể cả `tools` bị hiểu sai ở bản SDK sau, những cái này vẫn phải chết. */
const REVIEW_DENIED_TOOLS = ["Bash", "Task", "Agent", "WebFetch", "WebSearch", "NotebookEdit"];

// --- Đếm nhịp ---
//
// Ở turn-counter.ts, không phải ở đây: Stop hook của Claude Code cần đếm lượt mà
// không phải nạp SDK. Re-export để bot.ts và test cũ vẫn `import { noteTurn }`
// từ file này như trước.

export { noteTurn } from "./turn-counter.ts";

// --- Guard: chỉ được ghi vào skill của chính nó ---

/**
 * Thư mục skill được phép ghi: CHỈ kho global.
 *
 * Bài học rút từ một phiên hầu như không bao giờ chỉ đúng cho đúng repo đó — cách
 * debug, cách anh Tuấn muốn được trả lời, pattern dùng tool đều chuyển được sang
 * project khác. Ghi vào `<project>/.claude/skills` thì bài học chết theo cwd: phiên
 * sau mở repo khác là mất, và cùng một bài học phải học lại ở từng project.
 *
 * Skill riêng của project (godot, go-gamedev...) vẫn ĐỌC được để tham khảo — chỉ
 * đường ghi là bị khoá về một chỗ.
 *
 * Trả mảng vì guard bên dưới nhận nhiều thư mục; hôm nay mảng đó có đúng một phần tử.
 */
export function allowedSkillDirs(): string[] {
  return [GLOBAL_SKILLS_DIR];
}

/**
 * Đường dẫn có nằm trong một thư mục skill cho phép không.
 *
 * So sánh sau `resolve` và có `sep` ở đuôi: thiếu `sep` thì `~/.claude/skills-cua-anh`
 * cũng lọt vì nó cũng `startsWith("~/.claude/skills")`.
 */
export function isInsideSkillDirs(filePath: string, dirs: string[]): boolean {
  const target = resolve(filePath);
  return dirs.some((dir) => {
    const base = resolve(dir);
    return target === base || target.startsWith(base + sep);
  });
}

/**
 * Quyết định cho/chặn một lệnh ghi của fork review.
 *
 * Tách khỏi `canUseTool` để test được mà không cần dựng SDK. Trả `null` khi hợp lệ,
 * hoặc chuỗi lý do khi phải chặn.
 */
export function denyReasonForWrite(
  toolName: string,
  filePath: string | undefined,
  dirs: string[],
  readFile: (path: string) => string | null,
  newContent?: string,
): string | null {
  if (!filePath) return `${toolName} thiếu file_path`;
  if (!isInsideSkillDirs(filePath, dirs)) {
    return `Chỉ được ghi trong thư mục skill (${dirs.join(", ")}), không phải ${filePath}`;
  }

  const existing = readFile(filePath);
  if (existing === null) {
    // File mới: bắt buộc mang marker ngay từ lúc sinh, nếu không thì lần review
    // sau chính nó cũng không sửa được skill này nữa.
    if (toolName === "Write" && !(newContent ?? "").includes(PROVENANCE_MARKER)) {
      return `Skill mới phải có "${PROVENANCE_MARKER}" trong frontmatter metadata`;
    }
    return null;
  }

  if (!existing.includes(PROVENANCE_MARKER)) {
    return (
      `Skill này do anh Tuấn viết/cài, không phải do review sinh ra — không được sửa. ` +
      `Ghi nhận xét vào câu trả lời thay vì ghi đè.`
    );
  }
  return null;
}

/** Đọc đồng bộ: guard phải trả lời trước khi tool chạy, không có chỗ để await lười. */
function readFileSyncOrNull(path: string): string | null {
  try {
    const fs = require("fs") as typeof import("fs");
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Lý do chặn một lời gọi tool của fork, hoặc `null` nếu cho qua.
 * Dùng chung cho cả hook lẫn `canUseTool` để hai lớp không bao giờ lệch luật nhau.
 */
export function guardToolCall(toolName: string, input: Record<string, unknown>): string | null {
  if (REVIEW_DENIED_TOOLS.includes(toolName)) {
    return `Tool ${toolName} bị cấm trong skill review`;
  }
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
    const content = typeof input.content === "string" ? input.content : undefined;
    return denyReasonForWrite(toolName, filePath, allowedSkillDirs(), readFileSyncOrNull, content);
  }
  return null;
}

/**
 * Guard THẬT SỰ chặn được: `PreToolUse` hook.
 *
 * `canUseTool` bên dưới từng là lớp duy nhất và nó **không hề chạy** — SDK cảnh báo
 * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 11 lần: mọi entry auto-approve (cả `allowedTools`
 * truyền ở đây lẫn `permissions.allow` trong ~/.claude/settings.json, nơi có sẵn
 * "Read"/"Write"/"Edit" trần) đều duyệt tool TRƯỚC khi callback được hỏi. Nghĩa là suốt
 * thời gian đó fork review ghi được ra bất kỳ đâu. Hook thì chạy trước bước phân giải
 * quyền nên `deny` ở đây không ai qua mặt được.
 */
export function buildGuardHook(onDeny: (msg: string) => void) {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: unknown) => {
            const { tool_name, tool_input } = input as {
              tool_name?: string;
              tool_input?: Record<string, unknown>;
            };
            const reason = guardToolCall(tool_name ?? "", tool_input ?? {});
            if (reason) {
              onDeny(reason);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: reason,
                },
              };
            }
            return { continue: true };
          },
        ],
      },
    ],
  };
}

/** Lớp hai, phòng khi hook không chạy trên một bản SDK nào đó. */
function buildCanUseTool(onDeny: (msg: string) => void): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const reason = guardToolCall(toolName, input);
    if (reason) {
      onDeny(reason);
      return { behavior: "deny", message: reason };
    }
    return { behavior: "allow" };
  };
}

// --- Prompt ---

/**
 * Port của `_SKILL_REVIEW_PROMPT` (hermes-agent/agent/background_review.py:181).
 *
 * Giữ nguyên bốn thứ khiến bản gốc không đẻ rác:
 *   1. thứ tự ưu tiên vá-trước-tạo-sau,
 *   2. luật đặt tên ở tầng lớp việc,
 *   3. danh sách CẤM ghi (quan trọng nhất: cấm ghi lời phủ định về tool),
 *   4. "không có gì" là kết quả hợp lệ.
 */
export function buildSkillReviewPrompt(): string {
  const target = GLOBAL_SKILLS_DIR;

  return `[skill-review] Đọc lại hội thoại phía trên và cập nhật thư viện skill.

CHỦ ĐỘNG lên: phần lớn phiên làm việc đều để lại ít nhất một thứ đáng ghi. Một
lượt review không làm gì là một cơ hội học bị bỏ lỡ, không phải kết quả trung tính.

Hình dạng mong muốn của thư viện: skill ở TẦNG LỚP VIỆC, mỗi skill một SKILL.md
GỌN (dưới 400 dòng) chứa LUẬT, kèm thư mục \`references/\` giữ ca cụ thể. KHÔNG phải
một danh sách dài các skill hẹp kiểu mỗi-phiên-một-skill, cũng KHÔNG phải một file
khổng lồ kể lại mọi phiên đã gặp.

TOÀN CỤC, KHÔNG THEO PROJECT: mọi thứ em ghi đều nằm ở ${target} và sẽ được nạp
ở MỌI project. Trước khi viết, tự hỏi: "bài học này có còn đúng khi phiên sau mở
một repo khác không?".
  • Còn đúng → viết vào skill, diễn đạt ở mức chuyển được: nói về lớp việc và kỹ
    thuật, không phải về repo hôm nay.
  • Chỉ đúng với đúng repo này (tên bảng, hằng số nghiệp vụ, quy ước riêng của
    codebase) → KHÔNG viết vào SKILL.md. Cùng lắm là một ví dụ minh hoạ trong
    \`references/\`, và phải ghi rõ nó lấy từ project nào.
Skill riêng của project (trong \`<repo>/.claude/skills\`) em ĐỌC được để tham khảo
nhưng KHÔNG ghi vào đó — đường ghi duy nhất là ${target}.

TÍN HIỆU đáng hành động (có một cái là đủ):
  • Anh Tuấn sửa cách em trả lời: giọng văn, độ dài, định dạng, cách trình bày.
    Câu kiểu "dài quá", "đừng giải thích nữa", "chỉ cần kết quả", "sao lại làm thế"
    là tín hiệu SKILL hạng nhất, không chỉ là memory. Nhúng nó vào skill quản lớp
    việc đó để phiên sau bắt đầu là đã biết rồi.
  • Anh sửa quy trình, thứ tự bước, hay cách tiếp cận. Ghi thành pitfall hoặc bước
    bắt buộc trong skill tương ứng.
  • Xuất hiện kỹ thuật, cách sửa, đường debug, hay pattern dùng tool không tầm thường
    mà phiên sau sẽ cần.
  • Một skill đã được nạp trong phiên hoá ra sai, thiếu bước, hoặc lỗi thời — vá NGAY.

THỨ TỰ ƯU TIÊN — chọn hành động sớm nhất phù hợp:
  0. NÉN TRƯỚC KHI THÊM. Skill sắp vá đã quá 400 dòng thì việc ĐẦU TIÊN là đưa nó
     xuống dưới trần, rồi mới ghi thứ mới vào. Đây không phải việc dọn để dành lúc
     rảnh: vòng này chỉ biết thêm, nên không ai làm thì không bao giờ được làm.
  1. VÁ SKILL ĐÃ NẠP TRONG PHIÊN. Nhìn lại hội thoại xem skill nào đã được gọi qua
     tool \`Skill\`. Nếu nó phủ được phần kiến thức mới thì vá nó trước.
  2. VÁ SKILL Ô TỔNG có sẵn. Dùng Glob/Read để tìm trong ${target}.
     Thêm một mục, một pitfall, hoặc nới trigger.
  3. THÊM FILE PHỤ dưới skill ô tổng có sẵn:
     • \`references/<chủ-đề>.md\` — chi tiết theo phiên (log lỗi, cách tái hiện, quirk
       của thư viện) hoặc kiến thức cô đọng (trích tài liệu, ghi chú domain).
     • \`templates/<tên>.<ext>\` — file mẫu để copy rồi sửa.
     • \`scripts/<tên>.<ext>\` — việc chạy lại được (script verify, sinh fixture).
     Thêm một dòng trỏ tới file phụ trong SKILL.md để phiên sau biết nó tồn tại.
  4. TẠO SKILL Ô TỔNG MỚI khi chưa có gì phủ được lớp việc đó. Đặt ở ${target}.
     Tên PHẢI ở tầng lớp việc. KHÔNG được là số PR, chuỗi lỗi, tên codename, tên thư
     viện trần, hay kiểu "fix-X / debug-Y / audit-Z-hom-nay". Nếu cái tên chỉ có nghĩa
     với đúng task hôm nay thì nó sai — quay về (1), (2), hoặc (3).

QUY TẮC VIẾT SKILL.md:
  • NGÔN NGỮ: \`name\` và tên thư mục viết bằng TIẾNG ANH (nó là định danh, đồng bộ
    với skill Claude Code và plugin, tránh đẻ hai skill cùng nghĩa khác tên).
    \`description\` CŨNG viết TIẾNG ANH: nó là dòng quyết định skill có tự kích hoạt
    đúng lúc hay không, và hiện chưa có cách đo thoái hoá. Chỉ THÂN BÀI viết TIẾNG VIỆT —
    anh Tuấn ra lệnh bằng tiếng Việt và phải đọc lại được. Lệnh, thuật ngữ, tên API giữ
    nguyên tiếng Anh.
  • Frontmatter: \`name\` (chữ-thường-nối-gạch), \`description\` **tối đa 100 ký tự**
    kết thúc bằng dấu chấm, và \`metadata\` phải chứa đúng dòng \`${PROVENANCE_MARKER}\`.
  • Luật 100 ký tự là chuyện NGÂN SÁCH, không phải giới hạn kỹ thuật. Description KHÔNG
    bị cắt cụt — đo ngày 28/08/2026 cho thấy chi phí token tỉ lệ thẳng với độ dài
    (~3,6 ký tự/token, từ 48 tới 584 ký tự, không có ngưỡng nào). Nhưng nó nằm trong
    context của MỌI phiên, nên dài thêm là cả 64 skill cùng trả giá. 100 ký tự đủ nêu
    "làm gì + khi nào dùng"; dài hơn thì đẩy xuống thân bài. Viết xong hãy ĐẾM ký tự.
  • NGÂN SÁCH THÂN BÀI: SKILL.md tối đa **400 dòng**. Trần cứng — cổng
    \`scripts/check-skills.sh\` trong repo kuro đỏ nếu vượt. Con số lấy từ phân bố thật
    của 64 skill (trung vị 151, p90 319), không phải ước lượng.
  • NÉN = DỜI, KHÔNG XOÁ. Không bao giờ vứt một bài học đã học được. Cách nén:
    (a) ca cụ thể dài quá ~25 dòng (phiên nào, log gì, mutation nào) → chuyển NGUYÊN VĂN
        xuống \`references/<chủ-đề>.md\`, gom theo CƠ CHẾ chứ không theo thứ tự gặp;
        thân bài giữ 1-3 dòng: luật + dấu hiệu nhận biết + dòng trỏ file.
    (b) hai mục nói cùng một luật → GỘP thành một, giữ ví dụ mạnh hơn.
    Ngày 28/08/2026 làm đúng cách này: \`test-effectiveness\` 1099 → 337 dòng,
    \`subagent-orchestration\` 776 → 358, không mất một dòng nội dung nào.
  • ĐỌC TRƯỚC KHI ĐÁNH SỐ. Thêm mục vào danh sách đánh số thì đọc số lớn nhất đang có.
    Không đọc thì sinh ra hai mục cùng tên "Bẫy 20" — đã xảy ra thật.
  • Thân bài: tiêu đề, 2-3 câu mở (làm gì / KHÔNG làm gì), "## Khi nào dùng",
    "## Cách làm" (các bước kèm lệnh copy-paste được), "## Bẫy", "## Kiểm chứng".
  • Chỉ viết lệnh/đường dẫn/API đã THẤY THẬT trong hội thoại. Không bịa cờ, không
    bịa path.

CẤM GHI những thứ sau — chúng hoá đá thành ràng buộc tự trói về sau:
  • Lỗi do môi trường: thiếu binary, chưa cài package, sai path sau khi chuyển máy,
    "command not found", credential chưa cấu hình. Anh Tuấn sửa được — đó không phải
    luật bền.
  • Lời phủ định về tool hoặc tính năng ("tool X hỏng", "không dùng được Y"). Loại này
    đóng băng thành cớ để em từ chối làm việc, nhiều tháng sau khi lỗi đã được sửa.
  • Lỗi nhất thời đã tự hết trong phiên. Nếu retry là xong thì bài học là pattern
    retry, không phải lỗi ban đầu.
  • Tường thuật task một lần ("tóm tắt tin hôm nay", "review PR này") — không phải
    một lớp việc.
  • Chi tiết chỉ sống trong một repo: tên file/hàm cụ thể, đường dẫn tuyệt đối tới
    project, số liệu cân bằng game, schema bảng. Skill nằm ở kho dùng chung — nhét
    thứ này vào là làm nhiễu mọi project còn lại. Chỗ của chúng là memory.
Nếu một tool hỏng vì thiếu setup, hãy ghi CÁCH SỬA (lệnh cài, biến môi trường) vào
skill setup/troubleshooting — đừng bao giờ ghi "tool này không dùng được".

SKILL ĐƯỢC BẢO VỆ: skill nào KHÔNG có dòng \`${PROVENANCE_MARKER}\` là do anh Tuấn
viết hoặc cài — em không được sửa, ghi đè sẽ bị chặn ở tầng quyền. Nếu một skill như
vậy sai, hãy nói ra trong câu trả lời thay vì cố vá.

"Không có gì đáng ghi." là lựa chọn thật nhưng KHÔNG phải mặc định. Nếu phiên chạy
trơn tru, không bị sửa lưng, không sinh kỹ thuật mới thì trả lời đúng câu đó rồi dừng.
Ngược lại thì hành động.

Cuối cùng, trả lời NGẮN (tối đa 3 dòng): đã vá/tạo skill nào và ghi thêm điều gì.`;
}

// --- Chạy review ---

export interface SkillReviewOptions {
  /** Nguồn gọi review — id Telegram, hoặc `"cc"` cho phiên Claude Code CLI. Chỉ để log. */
  userId: number | string;
  /** Session vừa kết thúc — fork từ đây để có đủ ngữ cảnh hội thoại */
  sessionId: string;
  project: string;
  cwd?: string;
  /** Model của phiên chính. Dùng lại đúng model để fork ăn được prefix cache. */
  model?: string;
  /** Báo về Telegram khi review thực sự sửa/tạo skill. Không gọi khi "không có gì". */
  onLearned?: (summary: string) => void;
}

/**
 * Fork phiên vừa xong và để agent tự cập nhật skill. Không bao giờ ném lỗi:
 * đây là việc phụ chạy sau khi anh Tuấn đã nhận câu trả lời, hỏng thì im lặng bỏ qua.
 */
export async function reviewSkills(options: SkillReviewOptions): Promise<void> {
  const { userId, sessionId, project, cwd, model, onLearned } = options;

  if (!config.skillReviewEnabled) return;
  if (!sessionId) return; // chưa có transcript thì không có gì để đọc lại

  const denials: string[] = [];
  const controller = new AbortController();
  // Trần thời gian: review chạy nền nên không ai bấm /stop cho nó được.
  const timer = setTimeout(() => controller.abort(), config.skillReviewTimeoutMs);

  try {
    const stream = query({
      prompt: buildSkillReviewPrompt(),
      options: {
        model: model || config.claudeModel,
        resume: sessionId,
        // Fork: đọc được hội thoại cũ nhưng ghi sang session mới, nên transcript
        // của anh Tuấn không bị chèn thêm lượt review nào.
        forkSession: true,
        cwd: cwd || config.claudeWorkingDir,
        // `tools` cắt thật bộ tool. KHÔNG truyền `allowedTools`: nó chỉ auto-approve,
        // mà mọi entry auto-approve đều vô hiệu hoá `canUseTool` — đúng lỗi
        // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED làm guard nằm im suốt 11 lượt review.
        tools: REVIEW_TOOLS,
        disallowedTools: REVIEW_DENIED_TOOLS,
        // Chặn MCP server của máy (.mcp.json, plugin) lọt vào fork.
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: "default" as const,
        // Hai lớp cùng luật: hook là lớp chặn thật, canUseTool là lưới dự phòng.
        hooks: buildGuardHook((msg) => denials.push(msg)),
        canUseTool: buildCanUseTool((msg) => denials.push(msg)),
        maxTurns: config.skillReviewMaxTurns,
        abortController: controller,
      },
    });

    const textParts: string[] = [];
    const toolsUsed: string[] = [];

    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") textParts.push(block.text);
          if (block.type === "tool_use") toolsUsed.push(block.name);
        }
      }
      if (message.type === "result" && "result" in message && message.result && textParts.length === 0) {
        textParts.push(message.result);
      }
    }

    const summary = textParts.join("").trim();
    const wrote = toolsUsed.some((t) => t === "Write" || t === "Edit");

    if (denials.length > 0) {
      logger.warn(`🚧 Skill review bị chặn ${denials.length} lệnh ghi: ${denials[0]}`);
    }

    if (wrote) {
      logger.log(`🎓 Skill review (${project || "chung"}): ${summary.slice(0, 200)}`);
      onLearned?.(summary);
    } else {
      logger.log(`🎓 Skill review (${project || "chung"}): không có gì đáng ghi`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`⚠️ Skill review lỗi (user ${userId}): ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
