# my-assistant

Personal Telegram AI bot powered by **Claude** (Agent SDK). Send messages via Telegram — AI responds with streaming, tools, memory, Gmail, Google Sheets, news digests, and more.

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
- **Multi-project** — each project keeps its own session, working directory, and memory scope
- **Persistent Memory** — Tier 1 (passive extraction) + Tier 2 (active MCP tools)
- **Semantic search** — find memories by meaning (FTS5 + vector), auto-links related facts
- **Knowledge base** — store long documents, auto-chunked and semantically indexed
- **Entity graph** — extracts people/projects/technologies from stored content, cross-references them
- **File & photo upload** — AI analyzes files/images from Telegram
- **Gmail integration** — search, read, send, archive via MCP
- **Google Sheets integration** — read, write, append via MCP
- **News Digest** — daily news summary (HN + GitHub trending, 8am Vietnam time), or on demand via `/news`
- **Skills** — uses Claude Code skills directly (`~/.claude/skills/`, `<project>/.claude/skills/`, plugins) via the `Skill` tool
- **Content filter** — automatically hide secrets/credentials in responses
- **No turn or time limit** — long tasks run to completion; only `/stop` interrupts them
- **Model selection** — `/model` persists a per-user choice, or override a single message (`use opus`, `use fast`...)

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
CLAUDE_MODEL=claude-opus-5
```

### Config

```env
# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_ALLOWED_USERS=123456789    # REQUIRED — comma-separated user IDs

# Working directory
CLAUDE_WORKING_DIR=~/dev

# Session timeout
SESSION_TIMEOUT_HOURS=72

# Ask for Telegram confirmation before sending/trashing email (on by default)
# GMAIL_REQUIRE_CONFIRM=0

# Voyage AI — enables semantic search (optional; falls back to FTS5 keyword search)
VOYAGE_API_KEY=
VOYAGE_MODEL=voyage-4-lite
```

> **Security**: the bot runs an agent with shell access on the host. An empty whitelist means
> anyone who finds the bot can run commands, so startup **fails** when `TELEGRAM_ALLOWED_USERS`
> is empty — to intentionally open it up during development, set `ALLOW_ALL_USERS=1`.

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
| `balanced` | Sonnet 5 |
| `powerful` | Opus 5 |

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
bun run dev          # bun --watch run src/index.ts

# Check before deploying
bun run typecheck
bun test

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
│   ├── system-prompt.ts  # Loads CLAUDE.md as the persona
│   └── types.ts          # Provider interfaces
├── telegram/
│   ├── bot.ts            # Message handlers, streaming UX, queue
│   ├── commands.ts       # 13 bot commands
│   ├── middleware.ts      # Auth (whitelist)
│   ├── formatter.ts      # Message splitting & formatting
│   └── content-filter.ts # Secret redaction (15+ patterns)
├── db/
│   ├── connection.ts     # SQLite init, schema, migrations
│   ├── sessions.ts       # Session CRUD
│   ├── queries.ts        # Query log & analytics
│   ├── projects.ts       # Project registry + current project
│   └── user-model.ts     # Per-user model chosen via /model
├── memory/
│   ├── repository.ts     # Memory fact CRUD + FTS5 search
│   ├── extraction.ts     # Tier 1: passive fact extraction
│   └── consolidation.ts  # Daily dedup/merge facts
├── mcp/
│   ├── gmail.ts          # Gmail MCP server
│   ├── sheets.ts         # Google Sheets MCP server
│   └── memory.ts         # Tier 2: active memory MCP tools
└── scheduler/
    └── news-digest.ts    # Daily HN + GitHub trending digest
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Bot introduction |
| `/p [name]` | List projects, or switch to one (created on first use). `/p -` leaves the current project |
| `/new` | Start a new session |
| `/resume` | Resume a previous session (last 5) |
| `/model [tier]` | View/change model. No argument → button menu; `/model opus` switches directly; `/model reset` restores the default |
| `/status` | Model, uptime, usage stats |
| `/usage` | Token usage: today / 7 days / 30 days, broken down by model |
| `/memory` | View memory facts by category (with `#id`) |
| `/forget <id>` | Delete one fact from memory |
| `/news` | Fetch the tech digest now instead of waiting for the cron |
| `/reload` | Reload `CLAUDE.md` without restart |
| `/stop [name\|all]` | Abort a query: no argument → the current project; `/stop <name>` → that project; `/stop all` → every one |

## Multi-project

Each project keeps its own conversation session, so leaving `funlife` mid-task for
`my-assistant` and coming back later resumes where you left off.

**Projects run in parallel.** `/p` moves where you stand, it does not stop work in
progress: hand `funlife` a task, `/p my-assistant`, keep typing — both run at once.

- At most `MAX_CONCURRENT_PROJECTS` (default 3) projects call Claude simultaneously; past
  that, messages queue and show "⏳ waiting — N other projects running". A subscription
  shares one 5-hour budget, so raising this raises how fast you burn it.
- Within a **single project** messages still run serially (queue depth 3) — two queries
  resuming the same session would overwrite each other's transcript.
- A message's project is fixed **when you send it**, not when it runs: sending a task and
  then switching away never makes it run in the wrong directory.
- The result replaces that message's own "⏳ processing" bubble, keeping its place in the
  chat. If the bubble has scrolled out of sight, the bot posts a short `✅ [name] done`
  line at the bottom replying to it.
- `/status` lists running projects with elapsed seconds; `/p` marks busy ones with ⏳.

- `/p` — list projects
- `/p <name>` — switch to a project, creating it on first use
- `/p -` — leave the current project: root working directory, only global facts, and newly
  extracted facts are stored as global so they apply everywhere (`none`, `chung` also work)
- The working directory is **frozen exactly once**, the first time `/p <name>` runs
  (`~/dev/<name>` if it already exists, otherwise `CLAUDE_WORKING_DIR`) and **never changes
  afterward** — even if the project's own directory shows up later. Changing cwd mid-flight
  makes the Claude Agent SDK lose the running session's transcript (the session dies for
  good), so this is an intentional trade-off.
  ⚠️ **So `mkdir ~/dev/<name>` BEFORE running `/p <name>` for the first time** — running
  `/p` first and creating the directory afterward permanently pins that project to
  `CLAUDE_WORKING_DIR`. There's no "re-link" mechanism yet to fix it after the fact.
- ⚠️ next to a project name means the frozen directory doesn't match the project's own
  directory on disk (it never had one at creation time, one appeared later, or the frozen
  one was deleted) — the agent is running in `CLAUDE_WORKING_DIR` instead of the project's
  own directory
- Memory splits in two: global facts (preferences, habits) follow you everywhere; project
  facts (stack, architecture) only surface in their own project

## Memory System

**Tier 1 (Passive)** — Automatically extracts facts after each conversation, injected into the prompt as needed.

**Tier 2 (Active)** — Claude uses MCP tools to read/write:
- `memory_save` — save a new fact (auto-embeds and links similar facts); `scope` defaults to `project` (isolated per project)
- `memory_search` — hybrid FTS5 + vector search, returns related facts alongside
- `memory_list` — view all facts
- `memory_delete` — delete outdated/incorrect facts

**Knowledge base** — for content longer than a sentence:
- `knowledge_save` — store a document (auto-chunked, embedded, entities extracted)
- `knowledge_search` — search documents, returns the matching passage
- `knowledge_list` / `knowledge_delete` — manage documents
- `entity_search` — query the knowledge graph (people, projects, technologies, organizations)

**Semantic search requires `VOYAGE_API_KEY`.** Without it everything still works, just
falling back to keyword search (FTS5). Vectors are stored as little-endian f32 BLOBs,
byte-compatible with the Rust `memory-assistant`.

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

This bot can be cloned to run multiple instances in parallel, each as a separate persona/assistant (e.g., one bot for dev work, another for something else).

### How to

1. **Clone the project** to a new folder:
```bash
cp -r my-assistant /home/user/SecondBot
cd /home/user/SecondBot
rm -rf .git node_modules sessions.db*
bun install
```

2. **Customize the new instance**:
- `.env` — change `TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`, `CLAUDE_WORKING_DIR`
- `CLAUDE.md` — change persona (name, pronouns, personality, owner)
- Persona-specific skills — write them to `~/.claude/skills/<name>/SKILL.md`
- `ecosystem.config.cjs` — change `name` and add `CLAUDE_CONFIG_DIR`

3. **ecosystem.config.cjs** — set env directly (PM2 env overrides `.env`):
```javascript
// ecosystem.config.cjs
env: {
  TELEGRAM_BOT_TOKEN: "your-second-bot-token",
  TELEGRAM_ALLOWED_USERS: "user_id_1,user_id_2",
  CLAUDE_MODEL: "claude-sonnet-5",
  CLAUDE_WORKING_DIR: "/home/user/SecondBot",
  CLAUDE_CONFIG_DIR: "/home/user/.claude-bot2",
}
```

4. **Session isolation** — create a separate config dir and symlink credentials:
```bash
mkdir -p /home/user/.claude-bot2
# Symlink credentials to auto-receive token refresh from the main instance
ln -s ~/.claude/.credentials.json /home/user/.claude-bot2/.credentials.json
cp ~/.claude/settings.json /home/user/.claude-bot2/
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
