// src/services/web-monitor.ts
// ============================================================
// Web Monitor — Theo dõi thay đổi webpage, notify qua Telegram
// ============================================================
// Học từ: claude-code-templates/cloudflare-workers/docs-monitor
//
// Flow: fetch URL → strip HTML → SHA-256 hash → compare → notify
// Chạy cron mỗi 30 phút, lưu hash trong SQLite.
// ============================================================

import {
  getMonitoredUrls,
  updateUrlHash,
  type MonitoredUrl,
} from "../storage/db.ts";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 phút

let intervalId: ReturnType<typeof setInterval> | null = null;
let notifyFn: ((message: string) => Promise<void>) | null = null;

/**
 * Strip HTML tags, scripts, styles → plain text.
 * Normalize whitespace để tránh false positive từ formatting changes.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SHA-256 hash của string.
 */
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check 1 URL — fetch, hash, compare, notify nếu thay đổi.
 */
async function checkUrl(url: MonitoredUrl): Promise<void> {
  try {
    const response = await fetch(url.url, {
      headers: { "User-Agent": "KuroBot-Monitor/1.0" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.warn(`⚠️ Monitor: ${url.url} returned ${response.status}`);
      return;
    }

    const html = await response.text();
    const cleaned = stripHtml(html);
    const newHash = await sha256(cleaned);

    if (url.lastHash === null) {
      // Lần đầu — lưu hash, không notify
      updateUrlHash(url.id, newHash);
      console.log(`📡 Monitor: Saved initial hash for ${url.url}`);
      return;
    }

    if (newHash !== url.lastHash) {
      updateUrlHash(url.id, newHash);
      console.log(`📡 Monitor: Change detected at ${url.url}`);

      if (notifyFn) {
        const shortHash = (h: string) => h.slice(0, 8);
        await notifyFn(
          `🔔 Webpage thay đổi!\n\n` +
            `🔗 ${url.url}\n` +
            `📝 ${url.label || "Không có label"}\n\n` +
            `Hash: ${shortHash(url.lastHash)} → ${shortHash(newHash)}\n` +
            `⏰ ${new Date().toLocaleString("vi-VN")}`,
        );
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Monitor error for ${url.url}: ${errMsg}`);
  }
}

/**
 * Check tất cả URLs đang monitor.
 * Giới hạn 3 concurrent requests để không blast network.
 */
async function checkAll(): Promise<void> {
  const urls = getMonitoredUrls();
  if (urls.length === 0) return;

  console.log(`📡 Monitor: Checking ${urls.length} URLs...`);
  const concurrency = 3;
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(checkUrl));
  }
}

/**
 * Start web monitor cron.
 * @param notify — hàm gửi Telegram message
 */
export function startWebMonitor(
  notify: (message: string) => Promise<void>,
): void {
  notifyFn = notify;

  // Check ngay lần đầu (sau 10s để bot khởi động xong)
  setTimeout(() => checkAll(), 10_000);

  // Cron mỗi 30 phút
  intervalId = setInterval(() => checkAll(), CHECK_INTERVAL_MS);
  console.log("📡 Web Monitor started (check mỗi 30 phút)");
}

/**
 * Stop web monitor cron.
 */
export function stopWebMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("📡 Web Monitor stopped");
  }
}
