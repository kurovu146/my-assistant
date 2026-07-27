// tests/setup.ts
// ============================================================
// Preload cho bun test (khai báo trong bunfig.toml)
// ============================================================
// PHẢI là preload, không đặt trong file test: `import` được hoist nên
// mọi lệnh gán env viết trong file test đều chạy SAU khi config.ts và
// db/connection.ts đã đọc env — test sẽ ghi thẳng vào sessions.db thật.
// ============================================================

process.env.SESSIONS_DB_PATH = ":memory:";

// Bun tự nạp .env của project → phải gỡ key thật ra, test không gọi Voyage API
delete process.env.VOYAGE_API_KEY;
