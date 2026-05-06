import { Router, type Request, type Response } from "express";
import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKENS_PATH = path.join(os.homedir(), ".companion", "google-tokens.json");

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
}

function loadTokens(): { access_token?: string; refresh_token?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens: object) {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let devicePollTimer: ReturnType<typeof setInterval> | null = null;
let deviceFlowConnected = false;

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatEvent(e: {
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  location?: string | null;
}) {
  return {
    title: e.summary ?? "(no title)",
    time: e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "all day",
    location: e.location ?? null,
    allDay: !e.start?.dateTime,
  };
}

async function fetchAllCalendarEvents(
  calendarClient: ReturnType<typeof google.calendar>,
  timeMin: string,
  timeMax: string,
) {
  const calList = await calendarClient.calendarList.list({ minAccessRole: "reader" });
  const calIds = (calList.data.items ?? [])
    .filter((c) => c.selected !== false)
    .map((c) => c.id)
    .filter((id): id is string => !!id);

  const results = await Promise.allSettled(
    calIds.map((calId) =>
      calendarClient.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        maxResults: 50,
      }),
    ),
  );

  const allEvents = results.flatMap((r) =>
    r.status === "fulfilled" ? (r.value.data.items ?? []) : [],
  );

  allEvents.sort((a, b) => {
    const aKey = a.start?.dateTime ?? a.start?.date ?? "";
    const bKey = b.start?.dateTime ?? b.start?.date ?? "";
    return aKey.localeCompare(bKey);
  });

  return allEvents;
}

// Kept so index.ts import doesn't break — redirect flow is no longer used
export async function calendarOAuthCallback(_req: Request, res: Response): Promise<void> {
  res.status(410).send("Use the app to connect via device code.");
}

/**
 * Fetch a brief plain-text digest of today and tomorrow's events.
 * Returns null if calendar is not connected or an error occurs.
 */
export async function getCalendarDigest(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) return null;

  try {
    const oauth2 = makeOAuth2Client();
    oauth2.setCredentials(tokens);
    oauth2.on("tokens", (newTokens) => {
      saveTokens({ ...tokens, ...newTokens });
      oauth2.setCredentials({ ...tokens, ...newTokens });
    });
    const calendar = google.calendar({ version: "v3", auth: oauth2 });

    const now = new Date();
    const rangeStart = new Date(now); rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd   = new Date(now); rangeEnd.setDate(rangeEnd.getDate() + 2); rangeEnd.setHours(23, 59, 59, 999);

    const allItems = await fetchAllCalendarEvents(calendar, rangeStart.toISOString(), rangeEnd.toISOString());
    if (allItems.length === 0) return null;

    const todayKey    = localDateKey(now);
    const tomorrowKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

    const todayEvents    = allItems.filter(e => (e.start?.dateTime ?? e.start?.date ?? "").slice(0, 10) === todayKey);
    const tomorrowEvents = allItems.filter(e => (e.start?.dateTime ?? e.start?.date ?? "").slice(0, 10) === tomorrowKey);

    const lines: string[] = [];
    const fmt = (e: typeof allItems[0]) => {
      const time = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "all day";
      return `  • ${time} — ${e.summary ?? "(no title)"}`;
    };

    if (todayEvents.length > 0) {
      lines.push(`\uD83D\uDCC5 Today`);
      todayEvents.forEach(e => lines.push(fmt(e)));
    }
    if (tomorrowEvents.length > 0) {
      if (lines.length) lines.push("");
      lines.push("Tomorrow");
      tomorrowEvents.forEach(e => lines.push(fmt(e)));
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

function makeAuthClient() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error("Calendar not connected");
  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens) => saveTokens({ ...tokens, ...newTokens }));
  return google.calendar({ version: "v3", auth: oauth2 });
}

export interface CalEventData {
  title: string;
  date: string;           // YYYY-MM-DD
  time?: string;          // HH:MM (omit for all-day)
  duration_minutes?: number;  // default 60
  description?: string;
  location?: string;
  all_day?: boolean;
}

export async function createCalendarEvent(data: CalEventData): Promise<{ ok: boolean; eventId?: string; link?: string; error?: string }> {
  try {
    const cal = makeAuthClient();
    const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const isAllDay = data.all_day || !data.time;

    const requestBody: Record<string, unknown> = {
      summary: data.title,
      description: data.description ?? undefined,
      location: data.location ?? undefined,
    };

    if (isAllDay) {
      requestBody.start = { date: data.date };
      requestBody.end = { date: data.date };
    } else {
      const startDt = `${data.date}T${data.time}:00`;
      const durationMs = (data.duration_minutes ?? 60) * 60 * 1000;
      const endDate = new Date(new Date(`${data.date}T${data.time}`).getTime() + durationMs);
      const pad = (n: number) => String(n).padStart(2, "0");
      const endDt = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
      requestBody.start = { dateTime: startDt, timeZone: tz };
      requestBody.end   = { dateTime: endDt,   timeZone: tz };
    }

    const resp = await cal.events.insert({ calendarId: "primary", requestBody });
    return { ok: true, eventId: resp.data.id ?? undefined, link: resp.data.htmlLink ?? undefined };
  } catch (err) {
    console.error("[calendar] createCalendarEvent error:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function findEventId(title: string, date: string): Promise<string | null> {
  try {
    const cal = makeAuthClient();
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);
    const resp = await cal.events.list({
      calendarId: "primary",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      q: title,
      singleEvents: true,
      maxResults: 10,
    });
    const match = (resp.data.items ?? []).find(e =>
      e.summary?.toLowerCase().includes(title.toLowerCase())
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export async function updateCalendarEvent(
  title: string,
  date: string,
  updates: Partial<CalEventData>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const cal = makeAuthClient();
    const eventId = await findEventId(title, date);
    if (!eventId) return { ok: false, error: `Event not found: "${title}" on ${date}` };

    const existing = await cal.events.get({ calendarId: "primary", eventId });
    const patch: Record<string, unknown> = {};
    if (updates.title) patch.summary = updates.title;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.location !== undefined) patch.location = updates.location;
    if (updates.time) {
      const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const useDate = updates.date ?? date;
      const startDt = `${useDate}T${updates.time}:00`;
      const durationMs = (updates.duration_minutes ?? 60) * 60 * 1000;
      const endDate = new Date(new Date(`${useDate}T${updates.time}`).getTime() + durationMs);
      const pad = (n: number) => String(n).padStart(2, "0");
      const endDt = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
      patch.start = { dateTime: startDt, timeZone: tz };
      patch.end   = { dateTime: endDt,   timeZone: tz };
    }

    await cal.events.patch({ calendarId: "primary", eventId, requestBody: patch });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteCalendarEvent(title: string, date: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const cal = makeAuthClient();
    const eventId = await findEventId(title, date);
    if (!eventId) return { ok: false, error: `Event not found: "${title}" on ${date}` };
    await cal.events.delete({ calendarId: "primary", eventId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createCalendarRouter(): Router {
  const router = Router();

  router.get("/calendar/status", (_req: Request, res: Response) => {
    const tokens = loadTokens();
    res.json({ connected: !!tokens?.refresh_token });
  });

  /**
   * POST /calendar/auth/device/start
   * Initiates Google device authorization flow.
   * Returns user_code + verification_url for the user to visit on any browser.
   * Polls Google in the background; saves tokens when the user approves.
   */
  router.post("/calendar/auth/device/start", async (_req: Request, res: Response) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      res.status(500).json({ error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not set in .env" });
      return;
    }

    if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
    deviceFlowConnected = false;

    try {
      // Step 1: request device code from Google
      const dcRes = await fetch("https://oauth2.googleapis.com/device/code", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          scope: "https://www.googleapis.com/auth/calendar",
        }),
      });
      const dc = await dcRes.json() as {
        device_code: string; user_code: string; verification_url: string;
        expires_in: number; interval: number; error?: string;
      };
      if (dc.error) { res.status(500).json({ error: dc.error }); return; }

      res.json({ user_code: dc.user_code, verification_url: dc.verification_url, expires_in: dc.expires_in });

      const expireAt = Date.now() + dc.expires_in * 1000;
      const pollMs = (dc.interval + 1) * 1000;

      devicePollTimer = setInterval(async () => {
        if (Date.now() > expireAt) {
          clearInterval(devicePollTimer!); devicePollTimer = null;
          return;
        }
        try {
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID!,
              client_secret: process.env.GOOGLE_CLIENT_SECRET!,
              device_code: dc.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          });
          const tokenData = await tokenRes.json() as { refresh_token?: string; access_token?: string; error?: string };
          if (tokenData.refresh_token) {
            saveTokens(tokenData);
            deviceFlowConnected = true;
            clearInterval(devicePollTimer!); devicePollTimer = null;
            console.log("[calendar] Google Calendar connected via device flow.");
          } else if (tokenData.error && tokenData.error !== "authorization_pending" && tokenData.error !== "slow_down") {
            console.error("[calendar] device poll error:", tokenData.error);
            clearInterval(devicePollTimer!); devicePollTimer = null;
          }
        } catch (err) {
          console.error("[calendar] device poll fetch error:", err);
        }
      }, pollMs);
    } catch (err) {
      console.error("[calendar] device start error:", err);
      res.status(500).json({ error: "Failed to start device flow" });
    }
  });

  router.get("/calendar/auth/device/status", (_req: Request, res: Response) => {
    const tokens = loadTokens();
    res.json({ connected: !!tokens?.refresh_token || deviceFlowConnected });
  });

  router.delete("/calendar/auth", (_req: Request, res: Response) => {
    try { fs.unlinkSync(TOKENS_PATH); } catch {}
    deviceFlowConnected = false;
    res.json({ ok: true });
  });

  router.get("/calendar/range", async (req: Request, res: Response) => {
    const tokens = loadTokens();
    if (!tokens?.refresh_token) {
      res.status(503).json({ error: "Calendar not connected" });
      return;
    }

    try {
      const oauth2 = makeOAuth2Client();
      oauth2.setCredentials(tokens);
      oauth2.on("tokens", (newTokens) => {
        const merged = { ...tokens, ...newTokens };
        saveTokens(merged);
        oauth2.setCredentials(merged);
      });

      const calendar = google.calendar({ version: "v3", auth: oauth2 });

      const startParam = req.query.start as string | undefined;
      const days = Math.min(Number(req.query.days ?? 7), 14);

      const rangeStart = startParam ? parseLocalDate(startParam) : new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + days);
      rangeEnd.setHours(23, 59, 59, 999);

      const allItems = await fetchAllCalendarEvents(calendar, rangeStart.toISOString(), rangeEnd.toISOString());

      const dayMap = new Map<string, { date: string; label: string; shortLabel: string; events: object[] }>();
      for (let i = 0; i < days; i++) {
        const d = new Date(rangeStart);
        d.setDate(d.getDate() + i);
        const key = localDateKey(d);
        const label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
        const shortLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        dayMap.set(key, { date: key, label, shortLabel, events: [] });
      }

      for (const e of allItems) {
        const dateKey = e.start?.dateTime
          ? localDateKey(new Date(e.start.dateTime))
          : (e.start?.date ?? "").slice(0, 10);
        const day = dayMap.get(dateKey);
        if (!day) continue;
        day.events.push(formatEvent(e));
      }

      res.json({ ok: true, days: Array.from(dayMap.values()) });
    } catch (err) {
      console.error("[calendar] range error:", err);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  router.post("/calendar/events", async (req: Request, res: Response) => {
    const data = req.body as CalEventData;
    if (!data.title || !data.date) {
      res.status(400).json({ error: "title and date are required" });
      return;
    }
    const result = await createCalendarEvent(data);
    res.json(result);
  });

  router.patch("/calendar/events/:id", async (req: Request, res: Response) => {
    const { title, date, ...updates } = req.body as { title: string; date: string } & Partial<CalEventData>;
    if (!title || !date) {
      res.status(400).json({ error: "title and date are required to locate the event" });
      return;
    }
    const result = await updateCalendarEvent(title, date, updates);
    res.json(result);
  });

  router.delete("/calendar/events", async (req: Request, res: Response) => {
    const { title, date } = req.body as { title?: string; date?: string };
    if (!title || !date) {
      res.status(400).json({ error: "title and date are required" });
      return;
    }
    const result = await deleteCalendarEvent(title, date);
    res.json(result);
  });

  return router;
}
