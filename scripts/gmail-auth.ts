#!/usr/bin/env bun
// scripts/gmail-auth.ts
// ============================================================
// One-time script: Lấy Gmail refresh token qua OAuth2 flow
//
// CÁCH DÙNG:
//   1. Tạo OAuth2 credentials ở Google Cloud Console
//      → APIs & Services → Credentials → OAuth 2.0 Client IDs
//      → Application type: Desktop app
//   2. Set env variables:
//      export GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
//      export GMAIL_CLIENT_SECRET=xxx
//   3. Chạy: bun run scripts/gmail-auth.ts
//   4. Browser mở → đăng nhập Google → cho phép
//   5. Copy refresh token → paste vào .env
// ============================================================

import { google } from "googleapis";
import { createServer } from "http";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_PORT = 3847;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Thiếu GMAIL_CLIENT_ID hoặc GMAIL_CLIENT_SECRET");
  console.error("   Set env trước khi chạy:");
  console.error("   export GMAIL_CLIENT_ID=xxx");
  console.error("   export GMAIL_CLIENT_SECRET=xxx");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Scope: gmail.modify cho read + write (không cần full access)
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // Force consent để luôn nhận refresh token
});

console.log("🔐 Gmail OAuth2 Setup");
console.log("=".repeat(50));
console.log("");
console.log("Đang mở browser...");
console.log("Nếu browser không tự mở, truy cập URL sau:");
console.log("");
console.log(authUrl);
console.log("");

// Mở browser
Bun.spawn(["open", authUrl]);

// Start local server để nhận callback
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400);
    res.end(`OAuth error: ${error}`);
    console.error(`❌ OAuth error: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end("Missing authorization code");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>✅ Thành công!</h1>
        <p>Refresh token đã được in ra terminal.</p>
        <p>Có thể đóng tab này.</p>
      </body></html>
    `);

    console.log("✅ Lấy token thành công!");
    console.log("");
    console.log("=".repeat(50));
    console.log("Thêm dòng sau vào file .env:");
    console.log("=".repeat(50));
    console.log("");
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("");
    console.log("=".repeat(50));

    if (!tokens.refresh_token) {
      console.warn("⚠️ Không nhận được refresh token!");
      console.warn("   Có thể app đã được authorize trước đó.");
      console.warn("   Vào https://myaccount.google.com/permissions → revoke → chạy lại.");
    }

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500);
    res.end("Token exchange failed");
    console.error("❌ Token exchange error:", err);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`⏳ Đang chờ Google callback trên port ${REDIRECT_PORT}...`);
});
