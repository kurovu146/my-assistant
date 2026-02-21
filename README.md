# my-assistant

Telegram bot AI cá nhân chạy trên Claude Agent SDK. Gửi tin nhắn qua Telegram, Claude xử lý với full tool access (đọc/ghi file, chạy lệnh, tìm kiếm web, Gmail...).

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- **Bot**: [grammY](https://grammy.dev)
- **DB**: SQLite (Bun built-in)
- **Email**: Gmail API (optional)

## Features

- **Streaming responses** — real-time progress, tool indicators, typing loop
- **Session management** — resume conversation, 72h timeout
- **Persistent Memory** — Tier 1 (passive extraction) + Tier 2 (active MCP tools)
- **File & photo upload** — Claude phân tích file/ảnh từ Telegram
- **Gmail integration** — search, read, send, archive qua MCP
- **Web Monitor** — theo dõi thay đổi URL (30 phút/lần), thông báo Telegram
- **News Digest** — tóm tắt tin tức hàng ngày (HN + GitHub trending, 8h sáng VN)
- **Skills system** — auto-load `.md` files, hot-reload khi thay đổi
- **Content filter** — tự động ẩn secrets/credentials trong response
- **Rate limiting** — 5 msg/phút/user
- `/stop` — abort query đang chạy

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) đã login (hoặc `ANTHROPIC_API_KEY`)

### Install

```bash
bun install
```

### Configure

```bash
cp .env.example .env
```

Chỉnh `.env`:

```env
# Bắt buộc
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=your-telegram-user-id   # bỏ trống = dev mode (allow all)

# Claude
CLAUDE_MODEL=claude-opus-4-6                   # default model
CLAUDE_WORKING_DIR=/path/to/working/directory  # workspace cho file operations
CLAUDE_MAX_TURNS=30                            # max agent loop iterations

# Session
SESSION_TIMEOUT_HOURS=72

# Gmail (optional)
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
```

**Auth modes** (chọn 1):
- **Subscription**: Dùng `~/.claude/.credentials.json` (không cần thêm key)
- **API Key**: Set `ANTHROPIC_API_KEY` trong `.env`

### Run

```bash
# Development
bun run src/index.ts

# Production (PM2)
pm2 start ecosystem.config.cjs
pm2 save
```

## Project Structure

```
src/
├── index.ts                  # Entry point, startup, cron services
├── config.ts                 # Config loader từ env vars
├── agent/
│   ├── claude.ts             # Claude SDK wrapper (retry, failover, streaming)
│   ├── router.ts             # Model override parser
│   └── skills.ts             # Skills loader + hot-reload watcher
├── bot/
│   ├── telegram.ts           # Message handlers, streaming UX, queue
│   ├── commands.ts           # 10 bot commands
│   ├── middleware.ts         # Auth (whitelist)
│   ├── formatter.ts          # Message splitting & formatting
│   └── content-filter.ts    # Secret redaction (15+ patterns)
├── storage/
│   └── db.ts                 # SQLite: sessions, memory, analytics, monitor
└── services/
    ├── gmail.ts              # Gmail MCP server (OAuth2)
    ├── memory.ts             # Tier 1: passive fact extraction (Haiku)
    ├── memory-mcp.ts         # Tier 2: active memory MCP tools
    ├── web-monitor.ts        # URL change detection (hash-based)
    ├── memory-consolidation.ts  # Daily dedup/merge facts
    └── news-digest.ts        # Daily HN + GitHub trending digest
skills/                       # Knowledge base (.md files, auto-loaded)
scripts/
├── deploy.sh                 # Production deploy (git pull → bun install → pm2 restart)
└── gmail-auth.ts             # One-time Gmail OAuth2 setup
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Giới thiệu bot |
| `/new` | Tạo phiên mới |
| `/resume` | Resume phiên cũ (5 phiên gần nhất) |
| `/stop` | Dừng query đang chạy |
| `/status` | Uptime, model, usage stats, skills loaded |
| `/reload` | Reload skills không cần restart |
| `/memory` | Xem memory facts theo category |
| `/monitor <url> [label]` | Thêm URL vào danh sách theo dõi |
| `/unmonitor <url>` | Xóa URL khỏi danh sách theo dõi |
| `/monitors` | Xem danh sách URLs đang theo dõi |

## Model Override

Mặc định dùng Opus 4.6. Override thủ công: `"dùng sonnet <prompt>"` hoặc `"use haiku <prompt>"`

## Memory System

**Tier 1 (Passive)** — Tự động extract facts sau mỗi hội thoại (Haiku), inject vào prompt khi cần.

**Tier 2 (Active)** — Claude dùng MCP tools để đọc/ghi:
- `memory_save` — lưu fact mới
- `memory_search` — tìm kiếm theo keyword (FTS5)
- `memory_list` — xem tất cả facts
- `memory_delete` — xóa fact cũ/sai

## Gmail Setup (Optional)

1. Tạo OAuth 2.0 credentials trên [Google Cloud Console](https://console.cloud.google.com)
2. Chạy auth flow:
   ```bash
   bun run scripts/gmail-auth.ts
   ```
3. Copy refresh token vào `.env`

## Deploy

```bash
# Lần đầu
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start khi reboot

# Cập nhật
./scripts/deploy.sh
```

## License

Private project.
