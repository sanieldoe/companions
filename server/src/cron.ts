/**
 * cron.ts
 *
 * Scheduled background jobs.
 *
 * Calendar digest: runs at the top of every hour from 08:00–22:00 (local time).
 * Fetches upcoming events and broadcasts a cal_digest event over WebSocket
 * to all connected clients.
 */

import cron from "node-cron";
import { WebSocketServer } from "ws";
import { getCalendarDigest } from "./calendar.js";
import { broadcastAll } from "./gateway.js";

let latestDigest: string | null = null;

export function getLatestCalDigest(): string | null {
  return latestDigest;
}

export function initCron(wss: WebSocketServer): void {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Top of every hour, 08:00–22:00
  cron.schedule("0 8-22 * * *", async () => {
    console.log("[cron] Running calendar digest...");
    try {
      const digest = await getCalendarDigest();
      if (!digest) {
        console.log("[cron] No events or calendar not connected — skipping.");
        return;
      }
      latestDigest = digest;
      broadcastAll(wss, { type: "cal_digest", text: digest });
      console.log("[cron] Digest broadcast to connected clients.");
    } catch (err) {
      console.error("[cron] Calendar digest error:", err);
    }
  }, { timezone: tz });

  console.log(`[cron] Calendar digest scheduled hourly 08:00–22:00 (${tz})`);
}
