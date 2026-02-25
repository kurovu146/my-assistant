# my-assistant

Personal Telegram AI bot powered by **Claude** (Agent SDK). Send messages via Telegram — AI responds with streaming, tools, memory, Gmail, Google Sheets, web monitoring, and more.

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
- **File & photo upload** — AI analyzes files/images from Telegram
- **Gmail integration** — search, read, send, archive via MCP
- **Google Sheets integration** — read, write, append via MCP
- **Web Monitor** — track URL changes every 30 minutes
- **News Digest** — daily news summary (HN + GitHub trending, 8am Vietnam time)
- **Skills system** — auto-load `.md` files, hot-reload on change
- **Content filter** — automatically hide secrets/credentials in responses
- **Auto-continue** — automatically continues when maxTurns is reached (up to 5 times, 180 turns)
- **Model override** — switch model tier at runtime (`use opus`, `use fast`...)
- `/stop` — abort a running query

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Claude Code CLI (logged in) or API key

### Install

```bash
bun install
cp .env.example .env
```

### Authentication

Get your API key at [console.anthropic.com](https://console.anthropic.com/settings/keys) and add it to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-xxx
CLAUDE_MODEL=claude-sonnet-4-6
```

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

Send a message with a prefix to temporarily switch model tier:

```
use opus review this code
use fast translate this
use powerful analyze architecture
```

| Tier | Model |
|------|-------|
| `fast` | Haiku 4.5 |
| `balanced` | Sonnet 4.6 |
| `powerful` | Opus 4.6 |

### Planning (Optional)

Create a `PLAN.md` at root to keep your development plans. This file is in `.gitignore` to prevent leaking sensitive info:

```bash
touch PLAN.md
# Write your plans, notes, TODOs here
```

> **Note**: Do not commit `PLAN.md` as it may contain tokens, credentials, or private information.

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
| `/start` | Bot introduction |
| `/new` | Start a new session |
| `/resume` | Resume a previous session (last 5) |
| `/stop` | Abort a running query |
| `/status` | Model, uptime, usage stats |
| `/reload` | Reload skills without restart |
| `/memory` | View memory facts by category |
| `/monitor <url> [label]` | Add URL to watch list |
| `/unmonitor <url>` | Remove URL from watch list |
| `/monitors` | View monitored URLs |

## Memory System

**Tier 1 (Passive)** — Automatically extracts facts after each conversation, injected into the prompt as needed.

**Tier 2 (Active)** — Claude uses MCP tools to read/write:
- `memory_save` — save a new fact
- `memory_search` — keyword search (FTS5)
- `memory_list` — view all facts
- `memory_delete` — delete outdated/incorrect facts

## Gmail Setup (Optional)

1. Create OAuth 2.0 credentials on [Google Cloud Console](https://console.cloud.google.com)
2. Run the auth flow:
   ```bash
   bun run scripts/gmail-auth.ts
   ```
3. Copy the refresh token to `.env`

## Google Sheets Setup (Optional)

Shares OAuth2 credentials with Gmail. If first time: re-run `bun run scripts/gmail-auth.ts` to grant additional spreadsheets scope.

## Deploy

```bash
# First time
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start on reboot

# Update
./scripts/deploy.sh
```

## Scaling — Running Multiple Bot Instances

This bot can be cloned to run multiple instances in parallel, each as a separate persona/assistant (e.g., Kuro for dev tasks, Judy for chat).

### How to

1. **Clone the project** to a new folder:
```bash
cp -r my-assistant /home/user/JudyBot
cd /home/user/JudyBot
rm -rf .git node_modules sessions.db*
bun install
```

2. **Customize the new instance**:
- `.env` — change `TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`, `CLAUDE_WORKING_DIR`
- `CLAUDE.md` — change persona (name, pronouns, personality, owner)
- `skills/` — add/remove skills appropriate to the persona
- `ecosystem.config.cjs` — change `name` and add `CLAUDE_CONFIG_DIR`

3. **ecosystem.config.cjs** — set env directly (PM2 env overrides `.env`):
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

4. **Session isolation** — create a separate config dir and symlink credentials:
```bash
mkdir -p /home/user/.claude-judy
# Symlink credentials to auto-receive token refresh from the main instance
ln -s ~/.claude/.credentials.json /home/user/.claude-judy/.credentials.json
cp ~/.claude/settings.json /home/user/.claude-judy/
```

> **Why symlink?** Claude OAuth tokens expire every few hours and auto-refresh. If you copy the file, the secondary instance will get `exit code 1` when the old token expires. Symlink ensures every instance always uses the latest token.

5. **Start**:
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

### Notes

- Each bot needs its own **Telegram token** (create via @BotFather)
- Same Claude subscription (Max/Pro) — shared credentials
- Separate `CLAUDE_CONFIG_DIR` to avoid session/state conflicts
- **Important**: PM2 env vars override `.env` file. Set all critical env vars (`TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`...) directly in `ecosystem.config.cjs`, don't rely only on `.env`
- RAM: ~200MB/instance. A 2GB VPS + swap can comfortably run 2-3 bots
- Bots **do not share** SQLite DB (sessions.db, memory) — each instance has its own DB

## License

MIT
