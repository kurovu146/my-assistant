// src/services/sheets.ts
// ============================================================
// Google Sheets MCP Server — In-process MCP server cho Sheets
//
// Dùng chung OAuth2 credentials với Gmail (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN).
// Yêu cầu: enable Google Sheets API trong Google Cloud Console
//   và thêm scope spreadsheets khi authorize.
//
// Tools:
//   sheets_read       — Đọc data từ sheet (range hoặc toàn bộ)
//   sheets_write      — Ghi data vào sheet (range)
//   sheets_append     — Thêm rows vào cuối sheet
//   sheets_list       — Liệt kê tất cả sheets trong spreadsheet
//   sheets_create     — Tạo sheet mới trong spreadsheet
// ============================================================

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { google, type sheets_v4 } from "googleapis";

// --- Sheets API Client ---

let sheetsClient: sheets_v4.Sheets | null = null;

function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

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

  sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
  return sheetsClient;
}

// --- Helpers ---

/**
 * Extract spreadsheet ID from URL or return as-is if already an ID.
 * Supports: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit...
 */
function extractSpreadsheetId(input: string): string {
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return input; // Assume it's already an ID
}

/**
 * Format 2D array to readable text table.
 */
function formatAsTable(values: string[][]): string {
  if (!values || values.length === 0) return "(trống)";

  // Find max width per column
  const colWidths: number[] = [];
  for (const row of values) {
    for (let i = 0; i < row.length; i++) {
      const len = (row[i] || "").length;
      colWidths[i] = Math.max(colWidths[i] || 0, len, 3);
    }
  }

  // Cap column widths at 40 chars
  const cappedWidths = colWidths.map((w) => Math.min(w, 40));

  const formatRow = (row: string[]) =>
    row
      .map((cell, i) => {
        const s = (cell || "").slice(0, 40);
        return s.padEnd(cappedWidths[i] || 3);
      })
      .join(" | ");

  const lines: string[] = [];
  lines.push(formatRow(values[0]));
  lines.push(cappedWidths.map((w) => "-".repeat(w)).join("-+-"));
  for (let i = 1; i < values.length; i++) {
    lines.push(formatRow(values[i]));
  }

  return lines.join("\n");
}

// --- MCP Server ---

export function createSheetsMcpServer() {
  // Reuse Gmail credentials — nếu không có thì skip
  if (
    !process.env.GMAIL_CLIENT_ID ||
    !process.env.GMAIL_CLIENT_SECRET ||
    !process.env.GMAIL_REFRESH_TOKEN
  ) {
    console.log("⚠️ Sheets MCP: Thiếu credentials, skip Google Sheets integration");
    return null;
  }

  return createSdkMcpServer({
    name: "sheets",
    version: "1.0.0",
    tools: [
      // ---- sheets_read ----
      tool(
        "sheets_read",
        "Đọc data từ Google Sheets. Truyền spreadsheet URL hoặc ID + range (A1 notation). Nếu không truyền range sẽ đọc toàn bộ sheet đầu tiên.",
        {
          spreadsheetId: z
            .string()
            .describe(
              "Spreadsheet URL (https://docs.google.com/spreadsheets/d/xxx/edit) hoặc ID"
            ),
          range: z
            .string()
            .optional()
            .describe(
              "A1 notation range (e.g. 'Sheet1!A1:E10', 'A:Z'). Mặc định đọc toàn bộ sheet đầu tiên."
            ),
        },
        async (args) => {
          const sheets = getSheetsClient();
          const id = extractSpreadsheetId(args.spreadsheetId);

          // Nếu không có range, lấy tên sheet đầu tiên
          let range = args.range;
          if (!range) {
            const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
            const firstSheet = meta.data.sheets?.[0]?.properties?.title || "Sheet1";
            range = firstSheet;
          }

          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: id,
            range,
          });

          const values = (res.data.values || []) as string[][];

          if (values.length === 0) {
            return {
              content: [{ type: "text", text: `Sheet trống (range: ${range})` }],
            };
          }

          const table = formatAsTable(values);
          const text = `📊 **${range}** (${values.length} rows x ${values[0].length} cols)\n\n\`\`\`\n${table}\n\`\`\``;

          // Truncate if too large
          if (text.length > 12000) {
            return {
              content: [
                {
                  type: "text",
                  text: text.slice(0, 12000) + "\n\n... (truncated, dùng range cụ thể hơn)",
                },
              ],
            };
          }

          return { content: [{ type: "text", text }] };
        }
      ),

      // ---- sheets_write ----
      tool(
        "sheets_write",
        "Ghi data vào Google Sheets. Ghi đè cells trong range chỉ định. Data là mảng 2D (rows x cols).",
        {
          spreadsheetId: z
            .string()
            .describe("Spreadsheet URL hoặc ID"),
          range: z
            .string()
            .describe("A1 notation range (e.g. 'Sheet1!A1:C3', 'Sheet1!A1')"),
          values: z
            .array(z.array(z.string()))
            .describe("2D array of values — mỗi inner array là 1 row"),
        },
        async (args) => {
          const sheets = getSheetsClient();
          const id = extractSpreadsheetId(args.spreadsheetId);

          const res = await sheets.spreadsheets.values.update({
            spreadsheetId: id,
            range: args.range,
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: args.values,
            },
          });

          return {
            content: [
              {
                type: "text",
                text: `✅ Đã ghi ${res.data.updatedRows} rows x ${res.data.updatedColumns} cols vào ${args.range}`,
              },
            ],
          };
        }
      ),

      // ---- sheets_append ----
      tool(
        "sheets_append",
        "Thêm rows vào cuối sheet (append). Tự động tìm dòng trống cuối cùng và ghi tiếp.",
        {
          spreadsheetId: z
            .string()
            .describe("Spreadsheet URL hoặc ID"),
          range: z
            .string()
            .describe("Sheet name hoặc range (e.g. 'Sheet1', 'Sheet1!A:Z')"),
          values: z
            .array(z.array(z.string()))
            .describe("2D array of values — mỗi inner array là 1 row"),
        },
        async (args) => {
          const sheets = getSheetsClient();
          const id = extractSpreadsheetId(args.spreadsheetId);

          const res = await sheets.spreadsheets.values.append({
            spreadsheetId: id,
            range: args.range,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: {
              values: args.values,
            },
          });

          const updated = res.data.updates;
          return {
            content: [
              {
                type: "text",
                text: `✅ Đã thêm ${updated?.updatedRows || args.values.length} rows vào ${updated?.updatedRange || args.range}`,
              },
            ],
          };
        }
      ),

      // ---- sheets_list ----
      tool(
        "sheets_list",
        "Liệt kê tất cả sheets (tabs) trong 1 spreadsheet. Trả về tên sheet, ID, số rows/cols.",
        {
          spreadsheetId: z
            .string()
            .describe("Spreadsheet URL hoặc ID"),
        },
        async (args) => {
          const sheets = getSheetsClient();
          const id = extractSpreadsheetId(args.spreadsheetId);

          const res = await sheets.spreadsheets.get({
            spreadsheetId: id,
          });

          const title = res.data.properties?.title || "Untitled";
          const sheetList = res.data.sheets || [];

          let text = `📋 **${title}**\n\n`;
          text += sheetList
            .map((s, i) => {
              const props = s.properties;
              const rows = props?.gridProperties?.rowCount || 0;
              const cols = props?.gridProperties?.columnCount || 0;
              return `${i + 1}. **${props?.title}** (ID: ${props?.sheetId}, ${rows}x${cols})`;
            })
            .join("\n");

          return { content: [{ type: "text", text }] };
        }
      ),

      // ---- sheets_create_tab ----
      tool(
        "sheets_create_tab",
        "Tạo 1 sheet (tab) mới trong spreadsheet hiện tại.",
        {
          spreadsheetId: z
            .string()
            .describe("Spreadsheet URL hoặc ID"),
          title: z
            .string()
            .describe("Tên sheet mới"),
        },
        async (args) => {
          const sheets = getSheetsClient();
          const id = extractSpreadsheetId(args.spreadsheetId);

          const res = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: id,
            requestBody: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: args.title,
                    },
                  },
                },
              ],
            },
          });

          const newSheet = res.data.replies?.[0]?.addSheet?.properties;
          return {
            content: [
              {
                type: "text",
                text: `✅ Đã tạo sheet "${newSheet?.title}" (ID: ${newSheet?.sheetId})`,
              },
            ],
          };
        }
      ),
    ],
  });
}
