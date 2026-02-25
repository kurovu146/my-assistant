# my-assistant

Bot AI Telegram cá nhân, sử dụng **Claude** (Agent SDK). Gửi tin nhắn qua Telegram, AI xử lý với streaming, tools, memory, Gmail, Google Sheets, web monitor...

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Bot**: [grammY](https://grammy.dev)
- **DB**: SQLite (Bun built-in)
- **MCP**: Gmail, Google Sheets, Memory

## Tính năng

- **Claude Agent SDK** — đầy đủ tools (Bash, Read, Write, Edit, web search...), MCP servers, session resume
- **Streaming responses** — cập nhật tiến trình thời gian thực, hiển thị tool đang chạy, typing loop
- **Session management** — tiếp tục hội thoại, timeout 72h
- **Persistent Memory** — Tier 1 (passive extraction) + Tier 2 (active MCP tools)
- **Upload file & ảnh** — AI phân tích file/ảnh từ Telegram
- **Gmail integration** — search, read, send, archive qua MCP
- **Google Sheets integration** — read, write, append qua MCP
- **Web Monitor** — theo dõi thay đổi URL (30 phút/lần)
- **News Digest** — tóm tắt tin tức hàng ngày (HN + GitHub trending, 8h sáng VN)
- **Skills system** — tự động load file `.md`, hot-reload khi thay đổi
- **Content filter** — tự động ẩn secrets/credentials trong response
- **Auto-continue** — tự động tiếp tục khi hết maxTurns (tối đa 5 lần, 180 turns)
- **Model override** — đổi model tier runtime (`dung opus`, `use fast`...)
- `/stop` — dừng query đang chạy

## Cài đặt

### Yêu cầu

- [Bun](https://bun.sh) >= 1.0
- Claude Code CLI (đã login) hoặc API key

### Cài đặt

```bash
bun install
cp .env.example .env
```

### Xác thực

Lấy API key tại [console.anthropic.com](https://console.anthropic.com/settings/keys) và thêm vào `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-xxx
CLAUDE_MODEL=claude-sonnet-4-6
```

### Cấu hình

```env
# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_ALLOWED_USERS=123456789    # user ID cách nhau bởi dấu phẩy

# Thư mục làm việc
CLAUDE_WORKING_DIR=~/dev

# Timeout phiên hội thoại
SESSION_TIMEOUT_HOURS=72

# Số vòng lặp tối đa của agent
CLAUDE_MAX_TURNS=30
```

### Model Override (runtime)

Gửi tin nhắn với prefix để đổi model tier tạm thời:

```
dung opus review code này
use fast dịch đoạn này
use powerful phân tích kiến trúc
```

| Tier | Model |
|------|-------|
| `fast` | Haiku 4.5 |
| `balanced` | Sonnet 4.6 |
| `powerful` | Opus 4.6 |

### Planning (Tùy chọn)

Tạo `PLAN.md` ở root để ghi kế hoạch phát triển. File này nằm trong `.gitignore` để tránh leak thông tin nhạy cảm:

```bash
touch PLAN.md
# Ghi kế hoạch, notes, TODO... vào đây
```

> **Lưu ý**: Không commit `PLAN.md` vì có thể chứa tokens, credentials, hoặc thông tin riêng tư.

### Chạy

```bash
# Development
bun run src/index.ts

# Production (PM2)
pm2 start ecosystem.config.cjs
pm2 save
```

## Cấu trúc dự án

```
src/
├── index.ts              # Entry point, startup, cron services
├── config.ts             # Config loader (env vars, ~/ expansion)
├── logger.ts             # Logger theo múi giờ VN
├── claude/
│   ├── provider.ts       # ClaudeProvider + getClaudeProvider() singleton
│   ├── router.ts         # Model tier resolver (fast/balanced/powerful)
│   ├── skills.ts         # Skills loader + hot-reload watcher
│   └── types.ts          # Provider interfaces
├── telegram/
│   ├── bot.ts            # Message handlers, streaming UX, queue
│   ├── commands.ts       # 10 lệnh bot
│   ├── middleware.ts      # Auth (whitelist)
│   ├── formatter.ts      # Chia nhỏ & format tin nhắn
│   └── content-filter.ts # Ẩn secrets (15+ patterns)
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
skills/                   # Knowledge base (file .md, tự động load)
```

## Lệnh bot

| Lệnh | Mô tả |
|------|-------|
| `/start` | Giới thiệu bot |
| `/new` | Tạo phiên mới |
| `/resume` | Tiếp tục phiên cũ (5 phiên gần nhất) |
| `/stop` | Dừng query đang chạy |
| `/status` | Model, uptime, usage stats |
| `/reload` | Reload skills không cần restart |
| `/memory` | Xem memory facts theo category |
| `/monitor <url> [label]` | Thêm URL vào danh sách theo dõi |
| `/unmonitor <url>` | Xóa URL khỏi danh sách theo dõi |
| `/monitors` | Xem danh sách URLs đang theo dõi |

## Hệ thống Memory

**Tier 1 (Passive)** — Tự động extract facts sau mỗi hội thoại, inject vào prompt khi cần.

**Tier 2 (Active)** — Claude dùng MCP tools để đọc/ghi:
- `memory_save` — lưu fact mới
- `memory_search` — tìm kiếm theo keyword (FTS5)
- `memory_list` — xem tất cả facts
- `memory_delete` — xóa fact cũ/sai

## Cài đặt Gmail (Tùy chọn)

1. Tạo OAuth 2.0 credentials trên [Google Cloud Console](https://console.cloud.google.com)
2. Chạy auth flow:
   ```bash
   bun run scripts/gmail-auth.ts
   ```
3. Copy refresh token vào `.env`

## Cài đặt Google Sheets (Tùy chọn)

Dùng chung OAuth2 credentials với Gmail. Nếu lần đầu: chạy lại `bun run scripts/gmail-auth.ts` để cấp thêm scope spreadsheets.

## Deploy

```bash
# Lần đầu
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start khi reboot

# Cập nhật
./scripts/deploy.sh
```

## Scaling — Chạy nhiều bot instances

Bot này có thể clone để chạy nhiều instances song song, mỗi instance là 1 persona/assistant riêng (VD: Kuro cho dev, Judy cho chat).

### Cách làm

1. **Clone project** sang folder mới:
```bash
cp -r my-assistant /home/user/JudyBot
cd /home/user/JudyBot
rm -rf .git node_modules sessions.db*
bun install
```

2. **Customize cho instance mới**:
- `.env` — đổi `TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`, `CLAUDE_WORKING_DIR`
- `CLAUDE.md` — đổi persona (tên, xưng hô, tính cách, chủ nhân)
- `skills/` — thêm/bớt skills phù hợp với persona
- `ecosystem.config.cjs` — đổi `name` và thêm `CLAUDE_CONFIG_DIR`

3. **ecosystem.config.cjs** — set env trực tiếp (PM2 env override `.env` file):
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

4. **Session isolation** — tạo config dir riêng và symlink credentials:
```bash
mkdir -p /home/user/.claude-judy
# Symlink credentials để tự động nhận token refresh từ instance chính
ln -s ~/.claude/.credentials.json /home/user/.claude-judy/.credentials.json
cp ~/.claude/settings.json /home/user/.claude-judy/
```

> **Tại sao dùng symlink?** Claude OAuth token hết hạn mỗi vài giờ và tự động refresh. Nếu copy file, instance phụ sẽ bị `exit code 1` khi token cũ hết hạn. Symlink đảm bảo mọi instance luôn dùng token mới nhất.

5. **Start**:
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

### Lưu ý

- Mỗi bot cần **Telegram token riêng** (tạo qua @BotFather)
- Cùng 1 Claude subscription (Max/Pro) — dùng chung credentials
- `CLAUDE_CONFIG_DIR` riêng để tránh ghi đè session/state
- **Quan trọng**: PM2 env vars override `.env` file. Set tất cả env quan trọng (`TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`...) trực tiếp trong `ecosystem.config.cjs`, không chỉ dựa vào `.env`
- RAM: ~200MB/instance. VPS 2GB + swap chạy 2-3 bot thoải mái
- Các bot **không share** SQLite DB (sessions.db, memory) — mỗi instance có DB riêng

## Giấy phép

MIT
