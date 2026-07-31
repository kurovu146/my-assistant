# my-assistant

Bot AI Telegram cá nhân, sử dụng **Claude** (Agent SDK). Gửi tin nhắn qua Telegram, AI xử lý với streaming, tools, memory, Gmail, Google Sheets, news digest...

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
- **Multi-project** — mỗi project một phiên và một thư mục riêng, memory không lẫn giữa các project
- **Persistent Memory** — Tier 1 (passive extraction) + Tier 2 (active MCP tools)
- **Semantic search** — tìm memory theo ý nghĩa (FTS5 + vector), tự liên kết fact liên quan
- **Knowledge base** — lưu tài liệu dài, tự chia đoạn và đánh index ngữ nghĩa
- **Entity graph** — tự trích người/project/công nghệ từ nội dung đã lưu, tìm liên hệ chéo
- **Upload file & ảnh** — AI phân tích file/ảnh từ Telegram
- **Gmail integration** — search, read, send, archive qua MCP
- **Google Sheets integration** — read, write, append qua MCP
- **News Digest** — tóm tắt tin tức hàng ngày (HN + GitHub trending, 8h sáng VN) hoặc gọi ngay bằng `/news`
- **Skills** — dùng thẳng skill của Claude Code (`~/.claude/skills/`, `<project>/.claude/skills/`, plugin) qua tool `Skill`
- **Tự học (Tier 3)** — cứ 15 lượt lại fork phiên vừa xong để rút skill, luôn ghi vào kho toàn cục `~/.claude/skills/` nên bài học dùng được ở mọi project
- **Content filter** — tự động ẩn secrets/credentials trong response
- **Không giới hạn turn/thời gian** — task dài chạy tới khi xong, chỉ `/stop` mới dừng được
- **Chọn model** — `/model` lưu lựa chọn theo user, hoặc override từng tin nhắn (`dung opus`, `use fast`...)

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
CLAUDE_MODEL=claude-opus-5
```

### Cấu hình

```env
# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_ALLOWED_USERS=123456789    # BẮT BUỘC — user ID cách nhau bởi dấu phẩy

# Thư mục làm việc
CLAUDE_WORKING_DIR=~/dev

# Timeout phiên hội thoại
SESSION_TIMEOUT_HOURS=72

# Hỏi xác nhận qua Telegram trước khi gửi/xóa email (mặc định bật)
# GMAIL_REQUIRE_CONFIRM=0

# Voyage AI — bật semantic search (tùy chọn; thiếu key thì lùi về tìm bằng từ khóa)
VOYAGE_API_KEY=
VOYAGE_MODEL=voyage-4-lite
```

> **Bảo mật**: bot chạy agent với quyền shell trên máy chủ. Whitelist trống nghĩa là bất kỳ ai
> tìm ra bot cũng chạy được lệnh, nên bot sẽ **từ chối khởi động** nếu `TELEGRAM_ALLOWED_USERS`
> trống — muốn mở cho tất cả (dev) phải khai báo rõ `ALLOW_ALL_USERS=1`.

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
| `balanced` | Sonnet 5 |
| `powerful` | Opus 5 |

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
bun run dev          # bun --watch run src/index.ts

# Kiểm tra trước khi deploy
bun run typecheck
bun test

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
│   ├── system-prompt.ts  # Nạp CLAUDE.md làm persona
│   └── types.ts          # Provider interfaces
├── telegram/
│   ├── bot.ts            # Message handlers, streaming UX, queue
│   ├── commands.ts       # 13 lệnh bot
│   ├── middleware.ts      # Auth (whitelist)
│   ├── formatter.ts      # Chia nhỏ & format tin nhắn
│   └── content-filter.ts # Ẩn secrets (15+ patterns)
├── db/
│   ├── connection.ts     # SQLite init, schema, migrations
│   ├── sessions.ts       # Session CRUD
│   ├── queries.ts        # Query log & analytics
│   ├── projects.ts       # Project registry + project đang mở
│   └── user-model.ts     # Model từng user chọn qua /model
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

## Lệnh bot

| Lệnh | Mô tả |
|------|-------|
| `/start` | Giới thiệu bot |
| `/p [tên]` | Xem danh sách project, hoặc chuyển sang project (tạo nếu chưa có). `/p -` để thoát project |
| `/new` | Tạo phiên mới |
| `/resume` | Tiếp tục phiên cũ (5 phiên gần nhất) |
| `/model [tier]` | Xem/đổi model. Không tham số → menu nút bấm; `/model opus` đổi thẳng; `/model reset` về mặc định |
| `/status` | Model, uptime, usage stats |
| `/usage` | Token đã dùng: hôm nay / 7 ngày / 30 ngày, kèm breakdown theo model |
| `/memory` | Xem memory facts theo category (kèm `#id`) |
| `/forget <id>` | Xóa 1 fact khỏi memory |
| `/news` | Lấy digest tin công nghệ ngay, không đợi cron |
| `/stop [tên\|all]` | Dừng query: không tham số → project đang mở; `/stop <tên>` → đúng project đó; `/stop all` → tất cả |

## Multi-project

Mỗi project giữ một phiên hội thoại riêng, nên rời `funlife` giữa chừng sang `my-assistant`
làm việc khác rồi quay lại thì mạch cũ vẫn còn.

**Các project chạy song song.** `/p` chuyển chỗ đứng chứ không dừng việc: giao task cho
`funlife` rồi `/p my-assistant` nhắn tiếp, cả hai cùng chạy. Chi tiết:

- Tối đa `MAX_CONCURRENT_PROJECTS` (mặc định 3) project gọi Claude cùng lúc; quá thì tin
  nhắn xếp hàng và hiện "⏳ Đang chờ — N project khác đang chạy". Subscription dùng chung
  hạn mức 5h nên tăng số này là tăng tốc độ đốt quota tương ứng.
- Trong **cùng một project** thì vẫn tuần tự (tối đa 3 tin xếp hàng) — hai query cùng
  `resume` một session sẽ ghi đè transcript của nhau.
- Project của một tin nhắn được chốt **lúc anh gửi**, không phải lúc nó chạy: gửi xong rồi
  `/p` đi chỗ khác vẫn không làm tin đó chạy nhầm thư mục.
- Kết quả đè lên đúng tin "⏳ Đang xử lý" của nó, giữ nguyên vị trí trong mạch chat. Nếu tin
  đó đã trôi lên trên thì bot gửi thêm một dòng `✅ [tên] xong` ở cuối chat, reply tới nó.
- `/status` liệt kê project đang chạy kèm số giây; `/p` đánh dấu ⏳ cạnh project bận.

- `/p` — xem project đang có
- `/p <tên>` — chuyển sang project, tự tạo nếu chưa có
- `/p -` — thoát project, về trò chuyện chung: thư mục gốc, chỉ thấy fact chung, và fact
  mới rút ra được lưu dạng chung nên dùng lại được ở mọi project (cũng nhận `none`, `chung`)
- Thư mục làm việc được **chốt một lần duy nhất** lúc `/p <tên>` chạy lần đầu (`~/dev/<tên>`
  nếu đã tồn tại, không thì `CLAUDE_WORKING_DIR`) và **không đổi nữa về sau** — kể cả khi
  thư mục riêng xuất hiện sau đó. Đổi cwd giữa chừng làm Claude Agent SDK mất transcript
  của phiên đang chạy (phiên chết hẳn), nên đây là đánh đổi có chủ ý.
  ⚠️ **Vì vậy hãy `mkdir ~/dev/<tên>` TRƯỚC khi gõ `/p <tên>` lần đầu** — gõ `/p` trước rồi
  mới tạo thư mục thì project đó vĩnh viễn chạy ở `CLAUDE_WORKING_DIR`. Chưa có cơ chế
  "chốt lại" thư mục sau khi đã tạo project.
- Dấu ⚠️ cạnh project name = thư mục đã chốt không khớp thư mục riêng trên đĩa (chưa từng
  có thư mục riêng lúc tạo, thư mục riêng xuất hiện sau, hoặc thư mục đã chốt bị xoá) —
  agent đang chạy trong `CLAUDE_WORKING_DIR` thay vì thư mục riêng của project
- Memory chia hai loại: fact chung (sở thích, thói quen) theo anh khắp nơi; fact riêng
  (stack, kiến trúc) chỉ hiện ở đúng project của nó

## Hệ thống Memory

**Tier 1 (Passive)** — Tự động extract facts sau mỗi hội thoại, inject vào prompt khi cần.

**Tier 2 (Active)** — Claude dùng MCP tools để đọc/ghi:
- `memory_save` — lưu fact mới (tự embed + liên kết fact tương tự); `scope` mặc định `project` (không lẫn qua project khác)
- `memory_search` — tìm kiếm lai FTS5 + vector, trả kèm fact liên quan
- `memory_list` — xem tất cả facts
- `memory_delete` — xóa fact cũ/sai

**Knowledge base** — cho nội dung dài hơn một câu:
- `knowledge_save` — lưu tài liệu (tự chia đoạn, embed, trích entity)
- `knowledge_search` — tìm trong tài liệu, trả về đúng đoạn khớp
- `knowledge_list` / `knowledge_delete` — quản lý tài liệu
- `entity_search` — tra knowledge graph (người, project, công nghệ, tổ chức)

**Semantic search cần `VOYAGE_API_KEY`.** Không có key thì mọi thứ vẫn chạy, chỉ lùi về
tìm kiếm bằng từ khóa (FTS5). Vector lưu dạng BLOB f32 little-endian, cùng định dạng với
bản Rust `memory-assistant`.

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

Bot này có thể clone để chạy nhiều instances song song, mỗi instance là 1 persona/assistant riêng (VD: 1 bot cho dev, 1 bot cho việc khác).

### Cách làm

1. **Clone project** sang folder mới:
```bash
cp -r my-assistant /home/user/SecondBot
cd /home/user/SecondBot
rm -rf .git node_modules sessions.db*
bun install
```

2. **Customize cho instance mới**:
- `.env` — đổi `TELEGRAM_BOT_TOKEN`, `CLAUDE_MODEL`, `CLAUDE_WORKING_DIR`
- `CLAUDE.md` — đổi persona (tên, xưng hô, tính cách, chủ nhân)
- Skill riêng cho persona — viết vào `~/.claude/skills/<tên>/SKILL.md`
- `ecosystem.config.cjs` — đổi `name` và thêm `CLAUDE_CONFIG_DIR`

3. **ecosystem.config.cjs** — set env trực tiếp (PM2 env override `.env` file):
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

4. **Session isolation** — tạo config dir riêng và symlink credentials:
```bash
mkdir -p /home/user/.claude-bot2
# Symlink credentials để tự động nhận token refresh từ instance chính
ln -s ~/.claude/.credentials.json /home/user/.claude-bot2/.credentials.json
cp ~/.claude/settings.json /home/user/.claude-bot2/
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
