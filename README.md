# my-assistant

Telegram bot cá nhân chạy trên Claude Agent SDK. Gửi tin nhắn qua Telegram, Claude xử lý với full tool access (đọc/ghi file, chạy lệnh, search web, Gmail...).

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- **Bot**: [grammY](https://grammy.dev)
- **DB**: SQLite (Bun built-in)
- **Email**: Gmail API (optional)

## Features

- Streaming responses với real-time progress trên Telegram
- Session management (resume conversation, 72h timeout)
- File & photo upload → Claude phân tích
- `/stop` abort query đang chạy
- Rate limiting (5 msg/phút/user)
- Skills system (auto-load `.md` files)
- Gmail integration (search, read, send, archive)

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) đã login

### Install

```bash
bun install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=your-telegram-user-id
CLAUDE_MODEL=claude-sonnet-4-5-20250929
CLAUDE_WORKING_DIR=/path/to/working/directory
```

### Run

```bash
# Development
bun run src/index.ts

# Production (PM2)
pm2 start ecosystem.config.cjs
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Config loader
├── agent/
│   ├── claude.ts         # Claude SDK wrapper
│   └── skills.ts         # Skills loader
├── bot/
│   ├── telegram.ts       # Message handlers
│   ├── commands.ts       # Bot commands (/start, /new, /stop...)
│   ├── middleware.ts      # Auth + rate limiting
│   └── formatter.ts      # Message splitting & formatting
├── storage/
│   └── db.ts             # SQLite session management
└── services/
    └── gmail.ts          # Gmail MCP server
skills/                   # Knowledge base (.md files, auto-loaded)
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Giới thiệu bot |
| `/new` | Tạo phiên mới |
| `/resume` | Resume phiên cũ |
| `/stop` | Dừng query đang chạy |
| `/status` | Xem usage stats |
| `/reload` | Reload skills |

## Gmail (Optional)

1. Tạo OAuth 2.0 credentials trên [Google Cloud Console](https://console.cloud.google.com)
2. Chạy auth flow:
   ```bash
   bun run scripts/gmail-auth.ts
   ```
3. Thêm credentials vào `.env`

## License

Private project.
