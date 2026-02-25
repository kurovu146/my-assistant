# Plan: Xóa Judy Rust + Tạo Judy TS

## Mục tiêu
- Xóa bản Rust (`my-assistant-rs/`)
- Clone my-assistant sang `/home/kuro/JudyDev/` (ngang hàng với `dev/`)
- Customize thành Judy (persona, config, session isolation)

## Steps

### 1. Stop Judy Rust (nếu đang chạy) + xóa folder
```
rm -rf /home/kuro/dev/my-assistant-rs/
```

### 2. Clone my-assistant sang JudyDev
```
cp -r /home/kuro/dev/my-assistant /home/kuro/JudyDev
```
- Xóa `.git/`, `node_modules/`, `sessions.db*`, `.telegram-uploads/`
- Chạy `bun install` lại

### 3. Customize cho Judy

**a) `.env`** — đổi:
- `TELEGRAM_BOT_TOKEN` → token Judy: `8398555157:AAHiqCU65jdyFvzKi5eS745SOl8kMm2N2TE`
- `TELEGRAM_ALLOWED_USERS` → `1595473025` (anh Tuấn, tạm thời)
- `CLAUDE_MODEL` → `claude-sonnet-4-6`
- `CLAUDE_WORKING_DIR` → `/home/kuro/JudyDev`
- Xóa Gmail configs (Judy không cần)

**b) CLAUDE.md** — đổi persona:
- Tên: Judy (không phải Kuro)
- Chủ nhân: Chị Quyên
- Xưng hô: em/chị
- Tính cách: thân thiện, dễ thương, hay dùng emoji
- Gia đình: Kuro là chồng, anh Tuấn là admin

**c) `ecosystem.config.cjs`** — đổi:
- `name` → `judy`
- Thêm env `CLAUDE_CONFIG_DIR=/home/kuro/.claude-judy` (session isolation)

**d) Skills** — bỏ bớt skills chuyên code (go-gamedev, code-review), giữ skills chat-focused

### 4. Session isolation
- Dùng env `CLAUDE_CONFIG_DIR=/home/kuro/.claude-judy` trong ecosystem.config
- Đảm bảo `/home/kuro/.claude-judy/.credentials.json` tồn tại (copy từ `~/.claude/`)
- Mỗi bot có config dir riêng → không conflict session

### 5. Start Judy
```
cd /home/kuro/JudyDev && pm2 start ecosystem.config.cjs
pm2 save
```

### 6. Verify
- Gửi tin nhắn test cho Judy
- Kiểm tra Kuro vẫn hoạt động bình thường
