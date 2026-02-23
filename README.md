# my-assistant

Telegram bot AI ca nhan, su dung **Claude** (Agent SDK). Gui tin nhan qua Telegram, AI xu ly voi streaming, tools, memory, Gmail, Google Sheets, web monitor...

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Bot**: [grammY](https://grammy.dev)
- **DB**: SQLite (Bun built-in)
- **MCP**: Gmail, Google Sheets, Memory

## Features

- **Claude Agent SDK** — full tools (Bash, Read, Write, Edit, web search...), MCP servers, session resume
- **Streaming responses** — real-time progress, tool indicators, typing loop
- **Session management** — resume conversation, 72h timeout
- **Persistent Memory** — Tier 1 (passive extraction) + Tier 2 (active MCP tools)
- **File & photo upload** — AI phan tich file/anh tu Telegram
- **Gmail integration** — search, read, send, archive qua MCP
- **Google Sheets integration** — read, write, append qua MCP
- **Web Monitor** — theo doi thay doi URL (30 phut/lan)
- **News Digest** — tom tat tin tuc hang ngay (HN + GitHub trending, 8h sang VN)
- **Skills system** — auto-load `.md` files, hot-reload khi thay doi
- **Content filter** — tu dong an secrets/credentials trong response
- **Auto-continue** — tu dong tiep tuc khi het maxTurns (toi da 5 lan, 180 turns)
- **Model override** — doi model tier runtime (`dung opus`, `use fast`...)
- `/stop` — abort query dang chay

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Claude Code CLI (da login) hoac API key

### Install

```bash
bun install
cp .env.example .env
```

### Authentication

Claude ho tro 2 che do auth:

**a) Subscription (Max/Pro plan) — khong can API key:**

```bash
# 1. Login Claude Code CLI
claude

# 2. Config .env
CLAUDE_MODEL=claude-opus-4-6
```

Bot tu dung credentials tu `~/.claude/.credentials.json`. Day la cach khuyen dung — khong ton tien API, dung quota subscription.

**b) API Key:**

```bash
ANTHROPIC_API_KEY=sk-ant-xxx
CLAUDE_MODEL=claude-sonnet-4-6
```

Lay API key tai [console.anthropic.com](https://console.anthropic.com/settings/keys). Tinh phi theo token.

### Config

```env
# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_ALLOWED_USERS=123456789    # comma-separated user IDs

# Working directory
CLAUDE_WORKING_DIR=~/dev

# Session timeout
SESSION_TIMEOUT_HOURS=72

# Max agent loop iterations
CLAUDE_MAX_TURNS=30
```

### Model Override (runtime)

Gui tin nhan voi prefix de doi model tier tam thoi:

```
dung opus review code nay
use fast dich doan nay
use powerful phan tich kien truc
```

| Tier | Model |
|------|-------|
| `fast` | Haiku 4.5 |
| `balanced` | Sonnet 4.6 |
| `powerful` | Opus 4.6 |

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
├── index.ts              # Entry point, startup, cron services
├── config.ts             # Config loader (env vars, ~/ expansion)
├── logger.ts             # Logger with VN timezone
├── claude/
│   ├── provider.ts       # ClaudeProvider + getClaudeProvider() singleton
│   ├── router.ts         # Model tier resolver (fast/balanced/powerful)
│   ├── skills.ts         # Skills loader + hot-reload watcher
│   └── types.ts          # Provider interfaces
├── telegram/
│   ├── bot.ts            # Message handlers, streaming UX, queue
│   ├── commands.ts       # 10 bot commands
│   ├── middleware.ts      # Auth (whitelist)
│   ├── formatter.ts      # Message splitting & formatting
│   └── content-filter.ts # Secret redaction (15+ patterns)
├── db/
│   ├── connection.ts     # SQLite init, schema, migrations
│   ├── sessions.ts       # Session CRUD
│   ├── queries.ts        # Query log & analytics
│   └── monitors.ts       # URL monitoring CRUD
├── memory/
│   ├── repository.ts     # Memory fact CRUD + FTS5 search
│   ├── extraction.ts     # Tier 1: passive fact extraction
│   └── consolidation.ts  # Daily dedup/merge facts
├── mcp/
│   ├── gmail.ts          # Gmail MCP server
│   ├── sheets.ts         # Google Sheets MCP server
│   └── memory.ts         # Tier 2: active memory MCP tools
└── scheduler/
    ├── news-digest.ts    # Daily HN + GitHub trending digest
    └── web-monitor.ts    # URL change detection (hash-based)
skills/                   # Knowledge base (.md files, auto-loaded)
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Gioi thieu bot |
| `/new` | Tao phien moi |
| `/resume` | Resume phien cu (5 phien gan nhat) |
| `/stop` | Dung query dang chay |
| `/status` | Model, uptime, usage stats |
| `/reload` | Reload skills khong can restart |
| `/memory` | Xem memory facts theo category |
| `/monitor <url> [label]` | Them URL vao danh sach theo doi |
| `/unmonitor <url>` | Xoa URL khoi danh sach theo doi |
| `/monitors` | Xem danh sach URLs dang theo doi |

## Memory System

**Tier 1 (Passive)** — Tu dong extract facts sau moi hoi thoai, inject vao prompt khi can.

**Tier 2 (Active)** — Claude dung MCP tools de doc/ghi:
- `memory_save` — luu fact moi
- `memory_search` — tim kiem theo keyword (FTS5)
- `memory_list` — xem tat ca facts
- `memory_delete` — xoa fact cu/sai

## Gmail Setup (Optional)

1. Tao OAuth 2.0 credentials tren [Google Cloud Console](https://console.cloud.google.com)
2. Chay auth flow:
   ```bash
   bun run scripts/gmail-auth.ts
   ```
3. Copy refresh token vao `.env`

## Google Sheets Setup (Optional)

Dung chung OAuth2 credentials voi Gmail. Neu lan dau: chay lai `bun run scripts/gmail-auth.ts` de cap them scope spreadsheets.

## Deploy

```bash
# Lan dau
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start khi reboot

# Cap nhat
./scripts/deploy.sh
```

## Scaling — Chay nhieu bot instances

Bot nay co the clone de chay nhieu instances song song, moi instance la 1 persona/assistant rieng (VD: Kuro cho dev, Judy cho chat).

### Cach lam

1. **Clone project** sang folder moi:
```bash
cp -r my-assistant /home/user/JudyBot
cd /home/user/JudyBot
rm -rf .git node_modules sessions.db*
bun install
```

2. **Customize cho instance moi**:
- `.env` — doi `TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`, `CLAUDE_WORKING_DIR`
- `CLAUDE.md` — doi persona (ten, xung ho, tinh cach, chu nhan)
- `skills/` — them/bot skills phu hop voi persona
- `ecosystem.config.cjs` — doi `name` va them `CLAUDE_CONFIG_DIR`

3. **ecosystem.config.cjs** — set env truc tiep (PM2 env override .env file):
```javascript
// ecosystem.config.cjs
env: {
  TELEGRAM_BOT_TOKEN: "your-judy-bot-token",
  TELEGRAM_ALLOWED_USERS: "user_id_1,user_id_2",
  CLAUDE_MODEL: "claude-sonnet-4-6",
  CLAUDE_WORKING_DIR: "/home/user/JudyBot",
  CLAUDE_CONFIG_DIR: "/home/user/.claude-judy",
}
```

4. **Session isolation** — tao config dir rieng va symlink credentials:
```bash
mkdir -p /home/user/.claude-judy
# Symlink credentials de tu dong nhan token refresh tu instance chinh
ln -s ~/.claude/.credentials.json /home/user/.claude-judy/.credentials.json
cp ~/.claude/settings.json /home/user/.claude-judy/
```

> **Tai sao symlink?** Claude OAuth token het han moi vai gio va tu dong refresh. Neu copy file, instance phu se bi `exit code 1` khi token cu het han. Symlink dam bao moi instance luon dung token moi nhat.

5. **Start**:
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

### Luu y

- Moi bot can **Telegram token rieng** (tao qua @BotFather)
- Cung 1 Claude subscription (Max/Pro) — dung chung credentials
- `CLAUDE_CONFIG_DIR` rieng de tranh ghi de session/state
- **Quan trong**: PM2 env vars override `.env` file. Set tat ca env quan trong (`TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`...) truc tiep trong `ecosystem.config.cjs`, khong chi dua vao `.env`
- RAM: ~200MB/instance. VPS 2GB + swap chay 2-3 bot thoai mai
- Cac bot **khong share** SQLite DB (sessions.db, memory) — moi instance co DB rieng

## License

MIT
