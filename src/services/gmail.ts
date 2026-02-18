// src/services/gmail.ts
// ============================================================
// Gmail MCP Server — In-process MCP server cho Gmail operations
//
// Dùng createSdkMcpServer để tạo MCP server chạy trong process.
// Claude Agent SDK tự connect và gọi tools khi cần.
//
// Tools:
//   gmail_search      — Tìm email theo query
//   gmail_read        — Đọc nội dung 1 email
//   gmail_archive     — Archive emails (remove from INBOX)
//   gmail_trash       — Chuyển emails vào thùng rác
//   gmail_label       — Thêm/xóa labels
//   gmail_send        — Gửi email mới
//   gmail_list_labels — Liệt kê tất cả labels
// ============================================================

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { google, type gmail_v1 } from "googleapis";

// --- Gmail API Client ---

let gmailClient: gmail_v1.Gmail | null = null;

function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Thiếu GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, hoặc GMAIL_REFRESH_TOKEN trong .env"
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  gmailClient = google.gmail({ version: "v1", auth: oauth2Client });
  return gmailClient;
}

// --- Helpers ---

/**
 * Decode base64url encoded string (Gmail API format).
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Extract header value from Gmail message headers.
 */
function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

/**
 * Extract plain text body from Gmail message payload.
 * Handles both simple and multipart messages.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Simple message — body directly in payload
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    // Try text/plain first
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fallback to text/html (strip tags)
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      }
    }
    // Recursively check nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

/**
 * Encode email to base64url RFC 2822 format for sending.
 */
function encodeEmail(to: string, subject: string, body: string, cc?: string, bcc?: string): string {
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

// --- MCP Server ---

export function createGmailMcpServer() {
  // Check if Gmail credentials are configured
  if (
    !process.env.GMAIL_CLIENT_ID ||
    !process.env.GMAIL_CLIENT_SECRET ||
    !process.env.GMAIL_REFRESH_TOKEN
  ) {
    console.log("⚠️ Gmail MCP: Thiếu credentials, skip Gmail integration");
    return null;
  }

  return createSdkMcpServer({
    name: "gmail",
    version: "1.0.0",
    tools: [
      // ---- gmail_search ----
      tool(
        "gmail_search",
        "Search emails using Gmail query syntax. Returns a list of email summaries (id, subject, from, date, snippet). Use Gmail search operators like: is:unread, from:user@example.com, subject:keyword, newer_than:2d, has:attachment, label:name, category:promotions",
        {
          query: z.string().describe("Gmail search query (e.g. 'is:unread', 'from:boss@company.com newer_than:7d')"),
          maxResults: z.number().optional().describe("Max emails to return (default 10, max 50)"),
        },
        async (args) => {
          const gmail = getGmailClient();
          const maxResults = Math.min(args.maxResults || 10, 50);

          const res = await gmail.users.messages.list({
            userId: "me",
            q: args.query,
            maxResults,
          });

          const messages = res.data.messages || [];
          if (messages.length === 0) {
            return {
              content: [{ type: "text", text: "Không tìm thấy email nào." }],
            };
          }

          // Fetch metadata for each message
          const summaries = await Promise.all(
            messages.map(async (msg) => {
              const detail = await gmail.users.messages.get({
                userId: "me",
                id: msg.id!,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
              });
              const headers = detail.data.payload?.headers;
              return {
                id: msg.id,
                subject: getHeader(headers, "Subject") || "(no subject)",
                from: getHeader(headers, "From"),
                date: getHeader(headers, "Date"),
                snippet: detail.data.snippet || "",
                labels: detail.data.labelIds || [],
              };
            })
          );

          const text = summaries
            .map(
              (s, i) =>
                `${i + 1}. **${s.subject}**\n   From: ${s.from}\n   Date: ${s.date}\n   ID: ${s.id}\n   Labels: ${s.labels.join(", ")}\n   ${s.snippet}`
            )
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Tìm thấy ${summaries.length} email:\n\n${text}`,
              },
            ],
          };
        }
      ),

      // ---- gmail_read ----
      tool(
        "gmail_read",
        "Read the full content of a specific email by its message ID. Returns subject, from, to, date, body text, and attachment info.",
        {
          messageId: z.string().describe("The Gmail message ID (from gmail_search results)"),
        },
        async (args) => {
          const gmail = getGmailClient();

          const res = await gmail.users.messages.get({
            userId: "me",
            id: args.messageId,
            format: "full",
          });

          const headers = res.data.payload?.headers;
          const subject = getHeader(headers, "Subject") || "(no subject)";
          const from = getHeader(headers, "From");
          const to = getHeader(headers, "To");
          const date = getHeader(headers, "Date");
          const body = extractBody(res.data.payload);

          // Check for attachments
          const attachments: string[] = [];
          const parts = res.data.payload?.parts || [];
          for (const part of parts) {
            if (part.filename && part.filename.length > 0) {
              attachments.push(`${part.filename} (${part.mimeType}, ${part.body?.size || 0} bytes)`);
            }
          }

          let text = `**${subject}**\nFrom: ${from}\nTo: ${to}\nDate: ${date}\nLabels: ${(res.data.labelIds || []).join(", ")}\n`;

          if (attachments.length > 0) {
            text += `Attachments: ${attachments.join(", ")}\n`;
          }

          text += `\n---\n\n${body}`;

          // Truncate if too long
          if (text.length > 8000) {
            text = text.slice(0, 8000) + "\n\n... (truncated)";
          }

          return {
            content: [{ type: "text", text }],
          };
        }
      ),

      // ---- gmail_archive ----
      tool(
        "gmail_archive",
        "Archive emails by removing the INBOX label. Emails are NOT deleted, they just disappear from inbox. Accepts one or more message IDs.",
        {
          messageIds: z.array(z.string()).describe("Array of Gmail message IDs to archive"),
        },
        async (args) => {
          const gmail = getGmailClient();

          const results = await Promise.all(
            args.messageIds.map(async (id) => {
              try {
                await gmail.users.messages.modify({
                  userId: "me",
                  id,
                  requestBody: { removeLabelIds: ["INBOX"] },
                });
                return { id, ok: true };
              } catch (err: any) {
                return { id, ok: false, error: err.message };
              }
            })
          );

          const succeeded = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok);

          let text = `✅ Archived ${succeeded}/${args.messageIds.length} emails.`;
          if (failed.length > 0) {
            text += `\n❌ Failed: ${failed.map((f) => `${f.id}: ${f.error}`).join(", ")}`;
          }

          return { content: [{ type: "text", text }] };
        }
      ),

      // ---- gmail_trash ----
      tool(
        "gmail_trash",
        "Move emails to trash. They will be permanently deleted after 30 days. Accepts one or more message IDs.",
        {
          messageIds: z.array(z.string()).describe("Array of Gmail message IDs to trash"),
        },
        async (args) => {
          const gmail = getGmailClient();

          const results = await Promise.all(
            args.messageIds.map(async (id) => {
              try {
                await gmail.users.messages.trash({ userId: "me", id });
                return { id, ok: true };
              } catch (err: any) {
                return { id, ok: false, error: err.message };
              }
            })
          );

          const succeeded = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok);

          let text = `🗑️ Trashed ${succeeded}/${args.messageIds.length} emails.`;
          if (failed.length > 0) {
            text += `\n❌ Failed: ${failed.map((f) => `${f.id}: ${f.error}`).join(", ")}`;
          }

          return { content: [{ type: "text", text }] };
        }
      ),

      // ---- gmail_label ----
      tool(
        "gmail_label",
        "Add or remove labels from emails. Use gmail_list_labels first to get valid label IDs. Common labels: INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH.",
        {
          messageIds: z.array(z.string()).describe("Array of Gmail message IDs"),
          addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
          removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
        },
        async (args) => {
          const gmail = getGmailClient();

          if (!args.addLabelIds?.length && !args.removeLabelIds?.length) {
            return {
              content: [{ type: "text", text: "Cần ít nhất 1 label để thêm hoặc xóa." }],
            };
          }

          const results = await Promise.all(
            args.messageIds.map(async (id) => {
              try {
                await gmail.users.messages.modify({
                  userId: "me",
                  id,
                  requestBody: {
                    addLabelIds: args.addLabelIds || [],
                    removeLabelIds: args.removeLabelIds || [],
                  },
                });
                return { id, ok: true };
              } catch (err: any) {
                return { id, ok: false, error: err.message };
              }
            })
          );

          const succeeded = results.filter((r) => r.ok).length;
          const failed = results.filter((r) => !r.ok);

          let text = `✅ Updated labels for ${succeeded}/${args.messageIds.length} emails.`;
          if (args.addLabelIds?.length) text += `\n  Added: ${args.addLabelIds.join(", ")}`;
          if (args.removeLabelIds?.length) text += `\n  Removed: ${args.removeLabelIds.join(", ")}`;
          if (failed.length > 0) {
            text += `\n❌ Failed: ${failed.map((f) => `${f.id}: ${f.error}`).join(", ")}`;
          }

          return { content: [{ type: "text", text }] };
        }
      ),

      // ---- gmail_send ----
      tool(
        "gmail_send",
        "Send a new email. IMPORTANT: Always confirm with the user before sending. Include recipient, subject, and body.",
        {
          to: z.string().describe("Recipient email address"),
          subject: z.string().describe("Email subject"),
          body: z.string().describe("Email body (plain text)"),
          cc: z.string().optional().describe("CC email address(es), comma-separated"),
          bcc: z.string().optional().describe("BCC email address(es), comma-separated"),
        },
        async (args) => {
          const gmail = getGmailClient();

          const raw = encodeEmail(args.to, args.subject, args.body, args.cc, args.bcc);

          const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw },
          });

          return {
            content: [
              {
                type: "text",
                text: `✅ Email đã gửi thành công!\n  To: ${args.to}\n  Subject: ${args.subject}\n  Message ID: ${res.data.id}`,
              },
            ],
          };
        }
      ),

      // ---- gmail_list_labels ----
      tool(
        "gmail_list_labels",
        "List all Gmail labels (both system and custom). Useful to get label IDs for filtering or labeling operations.",
        {},
        async () => {
          const gmail = getGmailClient();

          const res = await gmail.users.labels.list({ userId: "me" });
          const labels = res.data.labels || [];

          const system = labels.filter((l) => l.type === "system");
          const user = labels.filter((l) => l.type === "user");

          let text = "**System labels:**\n";
          text += system.map((l) => `  ${l.id} — ${l.name}`).join("\n");

          if (user.length > 0) {
            text += "\n\n**Custom labels:**\n";
            text += user.map((l) => `  ${l.id} — ${l.name}`).join("\n");
          }

          return { content: [{ type: "text", text }] };
        }
      ),
    ],
  });
}
