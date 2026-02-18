#!/usr/bin/env bun
// scripts/gmail-purge.ts
// ============================================================
// Bulk trash ALL emails matching a query using Gmail batchModify.
// Moves up to 1000 emails per API call to TRASH — much faster
// than trashing one by one.
//
// Usage: bun run scripts/gmail-purge.ts [query]
//   Default query: "in:inbox"
//   Example: bun run scripts/gmail-purge.ts "from:noreply@wq.com"
// ============================================================

import { google } from "googleapis";

// Bun auto-loads .env

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

if (!clientId || !clientSecret || !refreshToken) {
  console.error("❌ Thiếu GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, hoặc GMAIL_REFRESH_TOKEN trong .env");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
oauth2Client.setCredentials({ refresh_token: refreshToken });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

const query = process.argv[2] || "in:inbox";
console.log(`🔍 Query: "${query}"`);
console.log("⏳ Đang lấy danh sách email...\n");

let totalTrashed = 0;
let retryCount = 0;
const MAX_RETRIES = 5;

// Loop qua tất cả pages — không dùng pageToken vì mỗi batch
// sẽ thay đổi kết quả search (emails đã trash sẽ không match nữa)
while (retryCount < MAX_RETRIES) {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 500,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) {
    break;
  }

  const ids = messages.map((m) => m.id!);
  console.log(`📦 Batch: Đang trash ${ids.length} emails...`);

  try {
    // batchModify — add TRASH label, remove INBOX
    // Dùng scope gmail.modify (không cần full mail.google.com scope)
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids,
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    });
    totalTrashed += ids.length;
    retryCount = 0; // Reset retry count on success
    console.log(`   ✅ Trashed ${ids.length} emails (tổng: ${totalTrashed})`);
  } catch (err: any) {
    // Rate limit — đợi rồi retry
    if (err.code === 429 || err.message?.includes("Rate") || err.message?.includes("concurrent")) {
      retryCount++;
      const wait = retryCount * 2;
      console.log(`   ⏳ Rate limited, đợi ${wait}s... (retry ${retryCount}/${MAX_RETRIES})`);
      await Bun.sleep(wait * 1000);
      continue;
    }

    // Scope error — try smaller batches with individual trash
    if (err.message?.includes("scope") || err.message?.includes("auth")) {
      console.log(`   ⚠️ batchModify không được phép, fallback sang trash từng email...`);
      let batchOk = 0;
      // Trash 25 tại 1 thời điểm (concurrency limit)
      for (let i = 0; i < ids.length; i += 25) {
        const chunk = ids.slice(i, i + 25);
        const results = await Promise.allSettled(
          chunk.map((id) => gmail.users.messages.trash({ userId: "me", id }))
        );
        const succeeded = results.filter((r) => r.status === "fulfilled").length;
        batchOk += succeeded;
        if (succeeded < chunk.length) {
          await Bun.sleep(1000); // Back off on partial failure
        }
      }
      totalTrashed += batchOk;
      console.log(`   ✅ Fallback trashed ${batchOk}/${ids.length} emails (tổng: ${totalTrashed})`);
      continue;
    }

    console.error(`   ❌ Lỗi: ${err.message}`);
    retryCount++;
    if (retryCount >= MAX_RETRIES) break;
  }

  // Small delay between batches
  await Bun.sleep(300);
}

console.log(`\n🎉 Done! Đã trash tổng cộng ${totalTrashed} emails.`);
