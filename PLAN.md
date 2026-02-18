# Plan: Gmail MCP Server Integration

## Tổng quan

Thêm Gmail integration cho Kuro bot bằng cách tạo **SDK MCP Server in-process** (dùng `createSdkMcpServer` + `googleapis`). Claude sẽ tự gọi Gmail tools khi cần.

## Approach: SDK MCP Server (in-process)

**Tại sao không dùng package có sẵn?**
- `@gongrzhe/server-gmail-autoauth-mcp` chạy qua stdio = spawn process mới mỗi query → chậm hơn
- In-process = zero latency, full control, dễ debug
- Dùng trực tiếp `googleapis` — official Google lib, stable

## Files cần tạo/sửa

### Tạo mới
1. **`src/services/gmail.ts`** — Gmail MCP server + OAuth2 + operations
   - `createGmailMcpServer()` — trả về MCP server instance
   - OAuth2 client setup (dùng refresh token từ env)
   - Tools: search, read, archive, trash, label, send

### Sửa
2. **`src/agent/claude.ts`** — Thêm MCP server vào `query()` options
3. **`src/config.ts`** — Thêm Gmail config (client_id, client_secret, refresh_token)
4. **`.env` + `.env.example`** — Thêm Gmail credentials
5. **`skills/gmail.md`** — Skill doc để Claude biết cách dùng Gmail tools
6. **`package.json`** — Thêm `googleapis`, `zod` dependencies

### Setup script (one-time)
7. **`scripts/gmail-auth.ts`** — Script chạy 1 lần để lấy refresh token qua OAuth2 flow

## Chi tiết implementation

### Step 1: Dependencies
```bash
bun add googleapis zod
```
(`zod` cần cho `createSdkMcpServer` tool schema)

### Step 2: `scripts/gmail-auth.ts` (one-time setup)
- Đọc Client ID + Secret từ .env
- Mở browser → Google OAuth consent → redirect về localhost
- Nhận authorization code → exchange lấy refresh token
- In ra refresh token → anh copy paste vào .env
- Chỉ cần chạy 1 lần

### Step 3: `src/services/gmail.ts`
```typescript
// Tạo OAuth2 client từ env credentials
// Tạo Gmail API client
// Tạo MCP server với các tools:

Tools:
├── gmail_search      — Tìm email (q: Gmail search syntax, maxResults)
├── gmail_read        — Đọc 1 email (messageId) → subject, from, date, body (text)
├── gmail_archive     — Archive emails (messageIds[])
├── gmail_trash       — Chuyển vào trash (messageIds[])
├── gmail_label       — Thêm/xóa label (messageIds[], addLabels[], removeLabels[])
├── gmail_send        — Gửi email (to, subject, body, cc?, bcc?)
└── gmail_list_labels — Liệt kê tất cả labels
```

### Step 4: `src/agent/claude.ts`
```typescript
// Import gmail server
import { createGmailMcpServer } from "../services/gmail.ts";

// Trong askClaude():
const gmailServer = createGmailMcpServer();

const stream = query({
  prompt,
  options: {
    // ... existing options ...
    mcpServers: {
      ...(gmailServer ? { gmail: gmailServer } : {}),
    },
    allowedTools: [
      ...existingTools,
      "mcp__gmail__*",  // Cho phép tất cả Gmail tools
    ],
  },
});
```

### Step 5: Config + Env
```env
# === GMAIL ===
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx
```

### Step 6: `skills/gmail.md`
Hướng dẫn Claude cách dùng Gmail tools:
- Khi nào search, khi nào read
- Gmail search syntax tips
- Batch operations
- Safety: xác nhận trước khi xóa/send

## OAuth2 Flow (one-time)

1. Anh đã có Google Cloud project + credentials
2. Chạy `bun run scripts/gmail-auth.ts`
3. Browser mở → đăng nhập Google → cho phép
4. Script in ra refresh token
5. Copy paste vào `.env`
6. Done — refresh token sống vĩnh viễn (nếu project ở production mode)

## Security Notes

- Refresh token chỉ lưu trong `.env` (gitignored)
- `permissionMode: "bypassPermissions"` đã có sẵn → Gmail tools sẽ được auto-approve
- Chỉ allowed user (anh) mới chat được với bot → safe
- Skill doc nhắc Claude xác nhận trước khi send/delete

## Test Plan

1. Build check: `bun typecheck`
2. Manual test qua Telegram:
   - "Kiểm tra gmail có bao nhiêu mail chưa đọc"
   - "Đọc mail mới nhất"
   - "Archive tất cả email quảng cáo"
   - "Gửi mail test cho [email]"
