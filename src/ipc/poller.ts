// src/ipc/poller.ts
// ============================================================
// IPC Poller — Poll shared DB cho tin nhắn từ bot khác
// ============================================================
//
// Mỗi 5s check ipc_messages có pending message cho mình không.
// Nếu có → claim → gọi provider.query() xử lý → notify owner.
// Dùng /ipc stop để tạm dừng, /ipc start để bật lại.
// ============================================================

import {
  claimPendingMessages,
  markIpcMessageDone,
  markIpcMessageError,
  cleanupOldIpcMessages,
} from "./shared-db.ts";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { getClaudeProvider } from "../claude/provider.ts";

const POLL_INTERVAL_MS = 5_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
let notifyFn: ((message: string) => Promise<void>) | null = null;
let processing = false;
let paused = false;

async function processPendingMessages(): Promise<void> {
  if (processing || paused) return;
  processing = true;

  try {
    const messages = claimPendingMessages(config.botName);
    if (messages.length === 0) return;

    for (const msg of messages) {
      // Re-check paused between messages (owner may /ipc stop mid-batch)
      if (paused) {
        markIpcMessageError(msg.id);
        continue;
      }

      try {
        logger.log(
          `📨 IPC: Processing #${msg.id} from ${msg.fromBot}: "${msg.message.slice(0, 60)}..."`,
        );

        const prompt = [
          `[📨 Tin nhắn từ ${msg.fromBot}]`,
          msg.replyTo ? `(Trả lời tin #${msg.replyTo})` : "",
          "",
          msg.message,
          "",
          `---`,
          `Đây là tin nhắn từ ${msg.fromBot} (bot AI partner).`,
          `Hãy trả lời tự nhiên. Nếu cần gửi reply, dùng tool bot_send_message (replyTo: ${msg.id}).`,
        ]
          .filter(Boolean)
          .join("\n");

        const provider = getClaudeProvider();
        const response = await provider.query({
          prompt,
          userId: config.allowedUsers[0],
        });

        // Notify owner about the exchange
        if (notifyFn) {
          const preview =
            response.text.length > 500
              ? response.text.slice(0, 500) + "..."
              : response.text;
          await notifyFn(
            `📨 Tin nhắn từ ${msg.fromBot}:\n` +
              `"${msg.message.slice(0, 300)}"\n\n` +
              `💬 ${config.botName} trả lời:\n${preview}`,
          );
        }

        markIpcMessageDone(msg.id);
        logger.log(`📨 IPC: Message #${msg.id} done`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`📨 IPC: Error processing #${msg.id}: ${errMsg}`);
        markIpcMessageError(msg.id);
      }
    }
  } finally {
    processing = false;
  }
}

export function startIpcPoller(
  notify: (message: string) => Promise<void>,
): void {
  notifyFn = notify;
  paused = false;

  pollIntervalId = setInterval(() => {
    processPendingMessages().catch((err) => {
      logger.error(
        "📨 IPC poll error:",
        err instanceof Error ? err.message : err,
      );
    });
  }, POLL_INTERVAL_MS);

  // Cleanup old messages daily
  cleanupIntervalId = setInterval(() => {
    const deleted = cleanupOldIpcMessages(7);
    if (deleted > 0) {
      logger.log(`📨 IPC: Cleaned up ${deleted} old messages`);
    }
  }, CLEANUP_INTERVAL_MS);

  logger.log(
    `📨 IPC Poller started (${config.botName}, every ${POLL_INTERVAL_MS / 1000}s)`,
  );
}

export function stopIpcPoller(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  paused = false;
  logger.log("📨 IPC Poller stopped");
}

/** Tạm dừng IPC — poller vẫn chạy nhưng skip processing */
export function pauseIpcPoller(): void {
  paused = true;
  logger.log("📨 IPC Poller paused");
}

/** Bật lại IPC sau khi pause */
export function resumeIpcPoller(): void {
  paused = false;
  logger.log("📨 IPC Poller resumed");
}

/** Check IPC đang paused hay không */
export function isIpcPaused(): boolean {
  return paused;
}

/** Check IPC poller có đang chạy không */
export function isIpcRunning(): boolean {
  return pollIntervalId !== null;
}
