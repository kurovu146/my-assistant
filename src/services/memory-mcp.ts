// src/services/memory-mcp.ts
// ============================================================
// Memory MCP Server — Cho phép Claude chủ động đọc/ghi memory
// ============================================================
//
// Tier 2: Active memory tools
// Claude tự quyết định khi nào ghi nhớ / tra cứu memory.
//
// Tools:
//   memory_save   — Lưu fact mới
//   memory_search — Tìm facts theo keyword
//   memory_list   — Liệt kê tất cả facts
//   memory_delete — Xóa fact
// ============================================================

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
  saveFact,
  searchFacts,
  getUserFacts,
  deleteFact,
  countFacts,
} from "../storage/db.ts";

/**
 * Tạo Memory MCP server cho 1 user cụ thể.
 * Mỗi query tạo 1 server mới với userId bind sẵn.
 */
export function createMemoryMcpServer(userId: number) {
  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: [
      // ---- memory_save ----
      tool(
        "memory_save",
        "Lưu một thông tin quan trọng vào bộ nhớ dài hạn. Dùng khi user chia sẻ preferences, quyết định, thông tin cá nhân, hoặc bất cứ điều gì cần nhớ cho các cuộc hội thoại sau. Categories: preference, decision, personal, technical, project, workflow.",
        {
          fact: z.string().describe("Thông tin cần nhớ (ngắn gọn, cụ thể)"),
          category: z
            .enum(["preference", "decision", "personal", "technical", "project", "workflow", "general"])
            .default("general")
            .describe("Phân loại thông tin"),
        },
        async (args) => {
          const saved = saveFact(userId, args.fact, args.category, "active");
          return {
            content: [
              {
                type: "text",
                text: `✅ Đã ghi nhớ (ID: ${saved.id}): "${args.fact}" [${args.category}]`,
              },
            ],
          };
        },
      ),

      // ---- memory_search ----
      tool(
        "memory_search",
        "Tìm kiếm trong bộ nhớ dài hạn theo keyword. Dùng khi cần nhớ lại thông tin user đã chia sẻ trước đó.",
        {
          keyword: z.string().describe("Từ khóa tìm kiếm"),
          limit: z.number().optional().default(10).describe("Số kết quả tối đa"),
        },
        async (args) => {
          const facts = searchFacts(userId, args.keyword, args.limit);

          if (facts.length === 0) {
            return {
              content: [
                { type: "text", text: `Không tìm thấy memory nào cho: "${args.keyword}"` },
              ],
            };
          }

          const text = facts
            .map(
              (f) => {
                const date = new Date(f.updatedAt).toLocaleDateString("vi-VN");
                const accessInfo = f.accessCount > 0 ? ` [x${f.accessCount}]` : "";
                return `[${f.id}] [${f.category}] ${f.fact} (${date}${accessInfo})`;
              },
            )
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Tìm thấy ${facts.length} memories:\n\n${text}`,
              },
            ],
          };
        },
      ),

      // ---- memory_list ----
      tool(
        "memory_list",
        "Liệt kê tất cả thông tin đã ghi nhớ về user. Dùng khi muốn xem tổng quan memory.",
        {
          category: z.string().optional().describe("Lọc theo category (để trống = tất cả)"),
          limit: z.number().optional().default(30).describe("Số kết quả tối đa"),
        },
        async (args) => {
          const facts = args.category
            ? (await import("../storage/db.ts")).getFactsByCategory(userId, args.category)
            : getUserFacts(userId, args.limit);

          const total = countFacts(userId);

          if (facts.length === 0) {
            return {
              content: [
                { type: "text", text: `Chưa có memory nào${args.category ? ` trong category "${args.category}"` : ""}.` },
              ],
            };
          }

          // Group by category
          const grouped = new Map<string, typeof facts>();
          for (const f of facts) {
            const list = grouped.get(f.category) || [];
            list.push(f);
            grouped.set(f.category, list);
          }

          let text = `Tổng: ${total} memories\n`;
          for (const [category, categoryFacts] of grouped) {
            text += `\n[${category}] (${categoryFacts.length})\n`;
            for (const f of categoryFacts) {
              text += `  [${f.id}] ${f.fact}\n`;
            }
          }

          return {
            content: [{ type: "text", text }],
          };
        },
      ),

      // ---- memory_delete ----
      tool(
        "memory_delete",
        "Xóa một memory theo ID. Dùng khi thông tin đã cũ hoặc sai.",
        {
          factId: z.number().describe("ID của memory cần xóa (lấy từ memory_list hoặc memory_search)"),
        },
        async (args) => {
          const deleted = deleteFact(userId, args.factId);
          if (deleted) {
            return {
              content: [{ type: "text", text: `✅ Đã xóa memory ID ${args.factId}.` }],
            };
          }
          return {
            content: [
              { type: "text", text: `❌ Không tìm thấy memory ID ${args.factId}.` },
            ],
          };
        },
      ),
    ],
  });
}
