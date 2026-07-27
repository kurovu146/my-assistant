// src/mcp/knowledge.ts
// ============================================================
// Knowledge MCP Server — tài liệu dài + entity graph
// ============================================================
// Tools:
//   knowledge_save   — Lưu tài liệu/bài viết/note (tự chunk + embed + trích entity)
//   knowledge_search — Tìm trong tài liệu (hybrid FTS + vector)
//   knowledge_list   — Liệt kê tài liệu đã lưu
//   entity_search    — Tìm entity và mọi nơi nó được nhắc tới
// ============================================================

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
  countDocuments,
  deleteDocument,
  listDocuments,
  saveDocument,
  searchKnowledge,
} from "../memory/knowledge.ts";
import { extractAndLinkEntities, searchEntities } from "../memory/entities.ts";

/** Tạo Knowledge MCP server cho 1 user cụ thể. */
export function createKnowledgeMcpServer(userId: number) {
  return createSdkMcpServer({
    name: "knowledge",
    version: "1.0.0",
    tools: [
      // ---- knowledge_save ----
      tool(
        "knowledge_save",
        "Lưu một tài liệu, bài viết, hoặc note dài vào knowledge base. Dùng cho nội dung dài cần tra cứu lại sau (khác memory_save dành cho fact ngắn một câu). Tài liệu được tự động chia nhỏ, đánh index để tìm kiếm theo ngữ nghĩa, và trích xuất entity.",
        {
          title: z.string().describe("Tiêu đề tài liệu"),
          content: z.string().describe("Nội dung đầy đủ"),
          source: z.string().optional().describe("Nguồn (URL, tên sách, người nói...)"),
          tags: z.string().optional().describe("Tags phân loại, cách nhau bởi dấu phẩy"),
        },
        async (args) => {
          const { docId, chunks, embedded } = await saveDocument(
            userId,
            args.title,
            args.content,
            args.source || "",
            args.tags || "",
          );
          const entityCount = await extractAndLinkEntities(userId, "document", docId, args.content);

          const parts = [`✅ Đã lưu tài liệu #${docId}: "${args.title}"`, `📄 ${chunks} đoạn`];
          if (embedded) parts.push("🧬 đã đánh index ngữ nghĩa");
          if (entityCount > 0) parts.push(`🏷 ${entityCount} entity`);
          return { content: [{ type: "text", text: parts.join(" · ") }] };
        },
      ),

      // ---- knowledge_search ----
      tool(
        "knowledge_search",
        "Tìm kiếm trong knowledge base (các tài liệu dài đã lưu). Trả về đoạn khớp nhất của mỗi tài liệu. Dùng khi cần tra cứu nội dung chi tiết đã lưu trước đó.",
        {
          keyword: z.string().describe("Từ khóa hoặc câu hỏi cần tìm"),
          limit: z.number().optional().default(5).describe("Số tài liệu tối đa"),
        },
        async (args) => {
          const hits = await searchKnowledge(userId, args.keyword, args.limit);
          if (hits.length === 0) {
            return {
              content: [{ type: "text", text: `Không tìm thấy tài liệu nào cho: "${args.keyword}"` }],
            };
          }

          const text = hits
            .map((h) => `📄 [${h.docId}] ${h.title}\n${h.chunk.slice(0, 600)}`)
            .join("\n\n---\n\n");
          return {
            content: [{ type: "text", text: `Tìm thấy ${hits.length} tài liệu:\n\n${text}` }],
          };
        },
      ),

      // ---- knowledge_list ----
      tool(
        "knowledge_list",
        "Liệt kê các tài liệu đã lưu trong knowledge base (mới nhất trước).",
        {
          limit: z.number().optional().default(20).describe("Số tài liệu tối đa"),
        },
        async (args) => {
          const docs = listDocuments(userId, args.limit);
          const total = countDocuments(userId);
          if (docs.length === 0) {
            return { content: [{ type: "text", text: "Knowledge base đang trống." }] };
          }

          const text = docs
            .map((d) => {
              const date = new Date(d.createdAt).toLocaleDateString("vi-VN");
              const tags = d.tags ? ` #${d.tags.split(",").join(" #")}` : "";
              return `[${d.id}] ${d.title} (${date}, ${d.content.length} ký tự)${tags}`;
            })
            .join("\n");
          return { content: [{ type: "text", text: `Tổng: ${total} tài liệu\n\n${text}` }] };
        },
      ),

      // ---- knowledge_delete ----
      tool(
        "knowledge_delete",
        "Xóa một tài liệu khỏi knowledge base theo ID (các đoạn và index đi kèm bị xóa theo).",
        {
          docId: z.number().describe("ID tài liệu (lấy từ knowledge_list hoặc knowledge_search)"),
        },
        async (args) => {
          const ok = deleteDocument(userId, args.docId);
          return {
            content: [
              {
                type: "text",
                text: ok
                  ? `✅ Đã xóa tài liệu #${args.docId}.`
                  : `❌ Không tìm thấy tài liệu #${args.docId}.`,
              },
            ],
          };
        },
      ),

      // ---- entity_search ----
      tool(
        "entity_search",
        "Tìm trong knowledge graph: người, project, công nghệ, tổ chức, khái niệm đã được trích xuất từ tài liệu và memory. Trả về entity kèm những nơi nó được nhắc tới — dùng để tìm mối liên hệ chéo giữa các nguồn.",
        {
          keyword: z.string().describe("Tên entity hoặc một phần tên"),
          limit: z.number().optional().default(10).describe("Số entity tối đa"),
        },
        async (args) => {
          const entities = searchEntities(userId, args.keyword, args.limit);
          if (entities.length === 0) {
            return {
              content: [{ type: "text", text: `Không tìm thấy entity nào khớp: "${args.keyword}"` }],
            };
          }

          const text = entities
            .map((e) => {
              const mentions = e.mentions
                .map((m) => `    · ${m.sourceType} #${m.sourceId}${m.context ? `: ${m.context}` : ""}`)
                .join("\n");
              return `🏷 ${e.name} [${e.entityType}] — ${e.mentions.length} lần nhắc\n${mentions}`;
            })
            .join("\n\n");
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });
}
