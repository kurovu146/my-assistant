// src/bot/formatter.ts
// ============================================================
// Formatter — Format output cho Telegram
// ============================================================
// Vấn đề cần giải quyết:
// 1. Telegram giới hạn 4096 ký tự/tin nhắn
//    → Cần chia nhỏ, nhưng không cắt giữa code block
// 2. Telegram MarkdownV2 yêu cầu escape rất nhiều ký tự
//    → Nhưng KHÔNG escape trong code blocks
// 3. Claude trả về Markdown chuẩn
//    → Cần convert sang format Telegram hiểu được
// ============================================================

const MAX_MESSAGE_LENGTH = 4000; // Để dư margin cho an toàn

/**
 * Icon mapping cho các tool Claude sử dụng.
 * Dùng chung cho cả streaming progress (telegram.ts) và footer (formatter.ts).
 */
export const TOOL_ICONS: Record<string, string> = {
  Bash: "⚡",
  Read: "📖",
  Write: "✏️",
  Edit: "✏️",
  Glob: "🔍",
  Grep: "🔎",
  WebSearch: "🌐",
  WebFetch: "📥",
};

/**
 * Chia tin nhắn dài thành nhiều phần.
 *
 * Cố gắng cắt tại vị trí hợp lý:
 * 1. Paragraph break (\n\n) — tốt nhất
 * 2. Newline đơn (\n) — OK
 * 3. Dấu chấm câu (. ) — chấp nhận được
 * 4. Cắt cứng — phương án cuối
 *
 * @example
 * splitMessage("ngắn") → ["ngắn"]
 * splitMessage("rất dài...5000 ký tự...") → ["phần 1...", "phần 2..."]
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const messages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      messages.push(remaining);
      break;
    }

    let cutPoint = MAX_MESSAGE_LENGTH;
    const searchZone = remaining.slice(0, MAX_MESSAGE_LENGTH);

    // Tránh cắt giữa code block (```)
    // Đếm số ``` trong vùng sẽ cắt — nếu lẻ = đang trong code block
    const backtickCount = (searchZone.match(/```/g) || []).length;
    if (backtickCount % 2 !== 0) {
      // Đang trong code block → tìm ``` kết thúc gần nhất trước cutPoint
      const lastCloseBlock = searchZone.lastIndexOf("```\n");
      if (lastCloseBlock > MAX_MESSAGE_LENGTH * 0.3) {
        cutPoint = lastCloseBlock + 4; // cắt sau ```\n
      }
      // Nếu không tìm thấy → cắt cứng + đóng code block
    }

    // Ưu tiên 1: Paragraph break
    const doubleNewline = remaining.lastIndexOf("\n\n", cutPoint);
    if (doubleNewline > cutPoint * 0.5) {
      cutPoint = doubleNewline + 2;
    } else {
      // Ưu tiên 2: Newline đơn
      const singleNewline = remaining.lastIndexOf("\n", cutPoint);
      if (singleNewline > cutPoint * 0.5) {
        cutPoint = singleNewline + 1;
      } else {
        // Ưu tiên 3: Dấu chấm câu
        const period = remaining.lastIndexOf(". ", cutPoint);
        if (period > cutPoint * 0.5) {
          cutPoint = period + 2;
        }
      }
    }

    let chunk = remaining.slice(0, cutPoint);

    // Nếu chunk có code block mở mà không đóng → đóng nó
    const chunkBackticks = (chunk.match(/```/g) || []).length;
    if (chunkBackticks % 2 !== 0) {
      chunk += "\n```";
    }

    messages.push(chunk);
    remaining = remaining.slice(cutPoint);

    // Nếu đoạn trước có code block không đóng, mở lại ở đoạn sau
    if (chunkBackticks % 2 !== 0) {
      // Tìm ngôn ngữ của code block mở cuối cùng
      const lastOpenIdx = chunk.lastIndexOf("```");
      const afterOpen = chunk.slice(lastOpenIdx + 3);
      const langMatch = afterOpen.match(/^(\w*)\n/);
      const lang = langMatch ? langMatch[1] : "";
      remaining = "```" + lang + "\n" + remaining;
    }
  }

  return messages;
}

/**
 * Format danh sách tools Claude đã dùng.
 * Hiển thị ở cuối tin nhắn để user biết Claude đã làm gì.
 *
 * @example
 * formatToolsUsed(["Read", "Bash"]) → "\n\n---\n🛠 Tools: 📖 Read  ⚡ Bash"
 */
export function formatToolsUsed(tools: string[]): string {
  if (tools.length === 0) return "";

  const toolEmojis = TOOL_ICONS;

  const formatted = tools
    .map((t) => `${toolEmojis[t] || "🔧"} ${t}`)
    .join("  ");

  return `Tools: ${formatted}`;
}

/**
 * Format thời gian tương đối cho hiển thị session.
 * Dùng trong /resume để user biết phiên nào mới/cũ.
 *
 * @example
 * timeAgo(Date.now() - 30000)     → "vừa xong"
 * timeAgo(Date.now() - 3600000)   → "1 giờ trước"
 * timeAgo(Date.now() - 172800000) → "2 ngày trước"
 */
export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "vừa xong";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return `${Math.floor(seconds / 86400)} ngày trước`;
}
