// src/mcp/memory.ts
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
  getUserFacts,
  getFactsByCategory,
  deleteFact,
  countFacts,
} from "../memory/repository.ts";
import { embedAndLinkFact, searchFactsHybrid } from "../memory/semantic.ts";
import { categoryGuide, CATEGORY_NAMES, FALLBACK_CATEGORY } from "../memory/categories.ts";
import { getCurrentProject } from "../db/projects.ts";

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
        `Lưu một thông tin quan trọng vào bộ nhớ dài hạn. Dùng khi user chia sẻ preferences, quyết định, thông tin cá nhân, hoặc bất cứ điều gì cần nhớ cho các cuộc hội thoại sau.\n\nCategories:\n${categoryGuide()}`,
        {
          fact: z.string().describe("Thông tin cần nhớ (ngắn gọn, cụ thể)"),
          category: z
            .enum([...CATEGORY_NAMES, FALLBACK_CATEGORY])
            .default(FALLBACK_CATEGORY)
            .describe("Phân loại thông tin — chọn nhãn sát nghĩa nhất"),
          scope: z
            .enum(["project", "global"])
            .default("project")
            .describe("global = đúng với mọi dự án; project = chỉ dự án đang mở"),
        },
        async (args) => {
          // getCurrentProject trả "" khi chưa chọn project — phải đổi thành null
          // (fact chung) chứ không lưu thẳng "", nếu không fact mồ côi ở project ""
          // chỉ hiện lại đúng lúc user chưa chọn project nào.
          const currentProject = getCurrentProject(userId) || null;
          const saved = saveFact(
            userId,
            args.fact,
            args.category,
            "active",
            args.scope === "global" ? null : currentProject,
          );
          const linked = await embedAndLinkFact(userId, saved.id, args.fact);

          let text = `✅ Đã ghi nhớ (ID: ${saved.id}): "${args.fact}" [${args.category}]`;
          if (linked.length > 0) {
            const list = linked
              .map((l) => `#${l.id} ${l.fact.slice(0, 50)} (${l.similarity.toFixed(2)})`)
              .join(", ");
            text += `\n🔗 Liên quan: ${list}`;
          }
          return { content: [{ type: "text", text }] };
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
          // Không truyền project thì mặc định chỉ thấy fact chung — memory_search
          // phải thấy được cả fact riêng của project đang mở, không thì tool này
          // "mất trí nhớ" ngay với đúng loại fact user vừa nhờ ghi nhớ.
          const hits = await searchFactsHybrid(userId, args.keyword, args.limit, getCurrentProject(userId));

          if (hits.length === 0) {
            return {
              content: [
                { type: "text", text: `Không tìm thấy memory nào cho: "${args.keyword}"` },
              ],
            };
          }

          const text = hits
            .map(({ fact: f, related }) => {
              const date = new Date(f.updatedAt).toLocaleDateString("vi-VN");
              const accessInfo = f.accessCount > 0 ? ` [x${f.accessCount}]` : "";
              let line = `[${f.id}] [${f.category}] ${f.fact} (${date}${accessInfo})`;
              if (related.length > 0) {
                const rel = related
                  .map((r) => `#${r.id} ${r.fact.slice(0, 40)} (${r.similarity.toFixed(2)})`)
                  .join(", ");
                line += `\n    ↳ liên quan: ${rel}`;
              }
              return line;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Tìm thấy ${hits.length} memories:\n\n${text}`,
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
          // getFactsByCategory chưa lọc theo project (ngoài phạm vi Task 7 — MemoryFact
          // chưa expose field project để lọc phía JS); nhánh không filter category thì
          // lọc được ngay bằng getUserFacts.
          const facts = args.category
            ? getFactsByCategory(userId, args.category)
            : getUserFacts(userId, args.limit, getCurrentProject(userId));

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
