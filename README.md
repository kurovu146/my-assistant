# my-assistant

Telegram bot AI cá nhân, hỗ trợ **nhiều AI provider** (Claude, OpenAI, Gemini, Ollama, DeepSeek). Gửi tin nhắn qua Telegram, AI xử lý với streaming, memory, Gmail, web monitor...

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: Multi-provider (Claude Agent SDK / OpenAI-compatible API)
- **Bot**: [grammY](https://grammy.dev)
- **DB**: SQLite (Bun built-in)
- **Email**: Gmail API (optional, Claude provider only)

## Features

- **Multi-provider** — Claude, OpenAI, Gemini, Ollama, DeepSeek (chọn 1 lúc deploy)
- **Streaming responses** — real-time progress, tool indicators, typing loop
- **Session management** — resume conversation, 72h timeout
- **Persistent Memory** — Tier 1 (passive extraction) + Tier 2 (active MCP tools, Claude only)
- **File & photo upload** — AI phân tích file/ảnh từ Telegram
- **Gmail integration** — search, read, send, archive qua MCP (Claude only)
- **Web Monitor** — theo dõi thay đổi URL (30 phút/lần)
- **News Digest** — tóm tắt tin tức hàng ngày (HN + GitHub trending, 8h sáng VN)
- **Skills system** — auto-load `.md` files, hot-reload khi thay đổi
- **Content filter** — tự động ẩn secrets/credentials trong response
- `/stop` — abort query đang chạy

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Tùy provider: Claude Code CLI, API key, hoặc Ollama server

### Install

```bash
bun install
cp .env.example .env
```

### Chọn Provider

Bot hỗ trợ 5 AI providers. Chọn **1 provider** duy nhất qua biến `AGENT_PROVIDER`.

#### Option 1: Claude (default)

Claude có 2 chế độ auth:

**a) Subscription (Max/Pro plan) — không cần API key:**

```bash
# 1. Login Claude Code CLI
claude

# 2. Config .env
AGENT_PROVIDER=claude
CLAUDE_MODEL=claude-opus-4-6
```

Bot tự dùng credentials từ `~/.claude/.credentials.json`. Đây là cách khuyên dùng — không tốn tiền API, dùng quota subscription.

**b) API Key:**

```bash
AGENT_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-xxx
CLAUDE_MODEL=claude-sonnet-4-6
```

Lấy API key tại [console.anthropic.com](https://console.anthropic.com/settings/keys). Tính phí theo token.

> Claude là provider duy nhất hỗ trợ **tools** (đọc/ghi file, chạy lệnh, web search), **MCP** (Gmail, Memory), và **session resume** native.

#### Option 2: OpenAI

```bash
AGENT_PROVIDER=openai
AGENT_API_KEY=sk-xxx
AGENT_MODEL=gpt-4o            # optional, default: gpt-4o
```

Lấy API key tại [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

#### Option 3: Gemini

```bash
AGENT_PROVIDER=gemini
AGENT_API_KEY=AIzaSyXXX
AGENT_MODEL=gemini-2.5-pro    # optional, default: gemini-2.5-pro
```

Lấy API key tại [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Free tier có sẵn.

#### Option 4: DeepSeek

```bash
AGENT_PROVIDER=deepseek
AGENT_API_KEY=sk-xxx
AGENT_MODEL=deepseek-chat      # hoặc deepseek-reasoner
```

Lấy API key tại [platform.deepseek.com](https://platform.deepseek.com/api_keys).

#### Option 5: Ollama (local, free)

```bash
# 1. Cài và chạy Ollama
ollama serve
ollama pull llama3.1

# 2. Config .env
AGENT_PROVIDER=ollama
AGENT_MODEL=llama3.1           # optional, default: llama3.1
AGENT_BASE_URL=http://localhost:11434   # optional, đây là default
```

Không cần API key. Chạy hoàn toàn local.

### Provider feature matrix

| Feature | Claude | OpenAI / Gemini / DeepSeek / Ollama |
|---------|--------|-------------------------------------|
| Chat + Streaming | Full | Full |
| Tools (Bash, Read, Write...) | Full support | Không |
| MCP (Gmail, Memory active) | Full support | Không |
| Session resume | Native SDK | In-memory history |
| Memory extraction | CompletionProvider | CompletionProvider |
| Model failover | Opus → Sonnet → Haiku | Không |

### Config chung

```env
# Working directory — hỗ trợ ~ (cross-platform Mac/Linux)
CLAUDE_WORKING_DIR=~/projects

# Session timeout
SESSION_TIMEOUT_HOURS=72

# Max agent loop iterations (Claude only)
CLAUDE_MAX_TURNS=30
```

### Model override (runtime)

Gửi tin nhắn với prefix để đổi model tier tạm thời:

```
dùng opus review code này
use fast dịch đoạn này
use powerful phân tích kiến trúc
```

| Tier | Claude | OpenAI | Gemini | Ollama | DeepSeek |
|------|--------|--------|--------|--------|----------|
| `fast` | Haiku 4.5 | gpt-4o-mini | gemini-2.0-flash | llama3.1 | deepseek-chat |
| `balanced` | Sonnet 4.6 | gpt-4o | gemini-2.5-pro | llama3.1 | deepseek-chat |
| `powerful` | Opus 4.6 | gpt-4o | gemini-2.5-pro | llama3.1:70b | deepseek-reasoner |

Backward compat: `dùng opus` = `use powerful`, `dùng haiku` = `use fast`.

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
├── config.ts                 # Config loader (~/ expansion, env vars)
├── agent/
│   ├── types.ts              # AgentProvider & CompletionProvider interfaces
│   ├── provider-factory.ts   # createProvider() — async factory
│   ├── provider-registry.ts  # Singleton getAgentProvider() / getCompletionProvider()
│   ├── claude.ts             # Facade (backward compat re-exports)
│   ├── router.ts             # Model tier resolver (fast/balanced/powerful)
│   ├── skills.ts             # Skills loader + hot-reload watcher
│   └── providers/
│       ├── claude.ts         # ClaudeProvider — full SDK (tools, MCP, sessions)
│       ├── base-chat.ts      # BaseChatProvider — raw fetch + SSE streaming
│       ├── openai.ts         # OpenAIProvider
│       ├── gemini.ts         # GeminiProvider
│       ├── ollama.ts         # OllamaProvider
│       └── deepseek.ts       # DeepSeekProvider
├── bot/
│   ├── telegram.ts           # Message handlers, streaming UX, queue
│   ├── commands.ts           # 10 bot commands
│   ├── middleware.ts         # Auth (whitelist)
│   ├── formatter.ts          # Message splitting & formatting
│   └── content-filter.ts     # Secret redaction (15+ patterns)
├── storage/
│   └── db.ts                 # SQLite: sessions, memory, analytics, monitor
└── services/
    ├── gmail.ts              # Gmail MCP server (Claude only)
    ├── memory.ts             # Tier 1: passive fact extraction
    ├── memory-mcp.ts         # Tier 2: active memory MCP tools (Claude only)
    ├── memory-consolidation.ts  # Daily dedup/merge facts
    ├── news-digest.ts        # Daily HN + GitHub trending digest
    └── web-monitor.ts        # URL change detection (hash-based)
skills/                       # Knowledge base (.md files, auto-loaded)
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Giới thiệu bot |
| `/new` | Tạo phiên mới |
| `/resume` | Resume phiên cũ (5 phiên gần nhất) |
| `/stop` | Dừng query đang chạy |
| `/status` | Provider, model, uptime, usage stats |
| `/reload` | Reload skills không cần restart |
| `/memory` | Xem memory facts theo category |
| `/monitor <url> [label]` | Thêm URL vào danh sách theo dõi |
| `/unmonitor <url>` | Xóa URL khỏi danh sách theo dõi |
| `/monitors` | Xem danh sách URLs đang theo dõi |

## Memory System

**Tier 1 (Passive)** — Tự động extract facts sau mỗi hội thoại, inject vào prompt khi cần.

**Tier 2 (Active, Claude only)** — Claude dùng MCP tools để đọc/ghi:
- `memory_save` — lưu fact mới
- `memory_search` — tìm kiếm theo keyword (FTS5)
- `memory_list` — xem tất cả facts
- `memory_delete` — xóa fact cũ/sai

## Gmail Setup (Optional, Claude only)

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
