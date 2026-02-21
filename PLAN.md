# Plan: Nâng cấp Kuro Bot — Học từ claude-code-templates

## Tổng quan

Dựa trên nghiên cứu repo `davila7/claude-code-templates` (20.7k stars), chọn lọc những tính năng phù hợp nhất để nâng cấp bot Kuro. Ưu tiên: thực dụng, không over-engineer, phù hợp Telegram bot.

---

## Phase 1: Content Filter — Security (Ưu tiên cao nhất)

**Học từ**: `hooks/security/secret-scanner.py` — scan 40+ secret patterns

**Vấn đề**: Hiện tại bot không kiểm tra response trước khi gửi. Nếu Claude vô tình in ra API key, password, token... sẽ gửi thẳng lên Telegram.

**Implement**:
- Tạo `src/bot/content-filter.ts`
- Scan response text trước khi gửi, redact các pattern: AWS keys, API keys, passwords, tokens, private keys, DB connection strings
- Cảnh báo `⚠️ Nội dung chứa thông tin nhạy cảm đã được ẩn`
- Apply vào `handleQueryWithStreaming()` trước khi edit/send message

**Files thay đổi**:
- Tạo mới: `src/bot/content-filter.ts`
- Sửa: `src/bot/telegram.ts` (gọi filter trước send)

---

## Phase 2: New Skills — Thêm kiến thức mới

**Học từ**: `skills/productivity/`, `skills/ai-research/`, `skills/security/`

### 2a. Skill: `telegram-ux.md`
Best practices khi trả lời trên Telegram:
- Response dưới 4000 chars khi có thể
- Dùng formatting hiệu quả (bold, code, list)
- Tóm tắt trước, chi tiết sau (progressive disclosure)
- Khi task phức tạp: báo tiến độ rõ ràng

### 2b. Skill: `security-awareness.md`
Từ security hooks + security agents:
- Khi review code: luôn check OWASP top 10
- Khi viết code: never hardcode secrets
- Khi gửi output: aware của sensitive data

**Files thay đổi**: Tạo mới 2 file trong `skills/`

---

## Phase 3: Query Analytics + `/stats` Command

**Học từ**: LangSmith tracing hook, command usage tracking, analytics features

**Implement**:
- Tạo bảng `query_logs` trong SQLite: timestamp, user_id, prompt_preview (50 chars), response_time_ms, tokens_in, tokens_out, cost_usd, tools_used
- Log mỗi query sau khi hoàn thành (trong `handleQueryWithStreaming`)
- Thêm `/stats` command: queries hôm nay, tổng tokens, tổng cost, top tools, average response time

**Files thay đổi**:
- Sửa: `src/storage/db.ts` (thêm bảng + log/query functions)
- Sửa: `src/bot/telegram.ts` (log sau mỗi query)
- Sửa: `src/bot/commands.ts` (thêm `/stats` handler)
- Sửa: `src/index.ts` (register command)

---

## Phase 4: Webpage Monitor

**Học từ**: `cloudflare-workers/docs-monitor/` — hash-compare-notify

**Implement**:
- Tạo `src/services/web-monitor.ts`
- Hàm `checkUrl(url)`: fetch → strip HTML → SHA-256 hash → compare with stored hash
- Lưu hash vào SQLite table `monitored_urls`
- Cron job (setInterval) check mỗi 30 phút
- Nếu thay đổi → gửi Telegram notification
- `/monitor <url>` — thêm URL để theo dõi
- `/unmonitor <url>` — bỏ theo dõi
- `/monitors` — list URLs đang monitor

**Files thay đổi**:
- Tạo mới: `src/services/web-monitor.ts`
- Sửa: `src/storage/db.ts` (thêm bảng)
- Sửa: `src/bot/commands.ts` (thêm commands)
- Sửa: `src/index.ts` (start cron + register commands)

---

## Thứ tự triển khai

1. **Phase 1**: Content Filter ← security, quan trọng nhất
2. **Phase 2**: New Skills ← dễ nhất, chỉ thêm .md files
3. **Phase 3**: Query Analytics ← data cho improvement
4. **Phase 4**: Web Monitor ← bonus feature hay

## Ước tính

- Files mới: ~5 files
- Files sửa: ~5 files
- Tổng: ~500-600 dòng code mới
- Không breaking changes
- Không thêm dependencies mới (dùng built-in crypto, fetch, SQLite)
