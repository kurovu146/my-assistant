// src/mcp/ipc.ts
// ============================================================
// IPC MCP Server — Tool gửi tin nhắn giữa các bot
// ============================================================
//
// Tool: bot_send_message — Gửi tin cho bot partner (kuro↔judy)
// ============================================================

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { sendIpcMessage } from "../ipc/shared-db.ts";
import { config } from "../config.ts";

export function createIpcMcpServer() {
  const myName = config.botName;
  const otherBot = myName === "kuro" ? "judy" : "kuro";

  return createSdkMcpServer({
    name: "ipc",
    version: "1.0.0",
    tools: [
      tool(
        "bot_send_message",
        `Gửi tin nhắn cho ${otherBot} (bot AI partner). Dùng khi cần nhờ ${otherBot} giúp, hỏi thông tin, hoặc relay tin nhắn từ chủ nhân. ${otherBot} sẽ nhận và trả lời sau vài giây.`,
        {
          message: z.string().describe(`Nội dung tin nhắn gửi cho ${otherBot}`),
          replyTo: z.number().optional().describe("ID tin nhắn đang reply (nếu trả lời tin cũ)"),
        },
        async (args) => {
          const sent = sendIpcMessage(myName, otherBot, args.message, args.replyTo);
          return {
            content: [
              {
                type: "text",
                text: `📨 Đã gửi tin nhắn cho ${otherBot} (ID: ${sent.id}). ${otherBot} sẽ nhận và trả lời sớm.`,
              },
            ],
          };
        },
      ),
    ],
  });
}
