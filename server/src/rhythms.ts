import { Router, type Request, type Response } from "express";
import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKENS_PATH = path.join(os.homedir(), ".companion", "google-tokens.json");

const VAULT_ROOT = process.env.COMPANION_VAULT ?? path.resolve(process.cwd(), "..");
const RHYTHMS_PATH = path.join(VAULT_ROOT, "tasks", "rhythms.json");

const DEFAULT_NOTIFY: Record<Rhythm["type"], number> = {
  daily: 60,
  weekly: 1440,
  monthly: 4320,
  annual: 10080,
};

const WEEKDAY_NAMES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface Rhythm {
  id: string;
  title: string;
  description?: string;
  type: "daily" | "weekly" | "monthly" | "annual";
  schedule: {
    days?: number[];
    dayOfMonth?: number;
    month?: number;
    day?: number;
  };
  notifyMinutes: number;
  active: boolean;
  createdAt: string;
  source: "manual" | "ingest";
  completions: string[];
  calEventId?: string;
}

export interface RhythmDue {
  id: string;
  title: string;
  type: Rhythm["type"];
  schedule: Rhythm["schedule"];
  dueDate: string;
  completed: boolean;
}

function loadRhythms(): Rhythm[] {
  try {
    const raw = fs.readFileSync(RHYTHMS_PATH, "utf-8");
    return JSON.parse(raw) as Rhythm[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("[rhythms] loadRhythms error:", err);
    return [];
  }
}

function saveRhythms(rhythms: Rhythm[]): void {
  try {
    fs.mkdirSync(path.dirname(RHYTHMS_PATH), { recursive: true });
    fs.writeFileSync(RHYTHMS_PATH, JSON.stringify(rhythms, null, 2), "utf-8");
  } catch (err) {
    console.error("[rhythms] saveRhythms error:", err);
  }
}

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function getCanonicalDueDate(rhythm: Rhythm, ref: Date): string {
  const refYear = ref.getFullYear();
  const refMonth = ref.getMonth();
  const refDay = ref.getDate();
  const refDow = ref.getDay();

  if (rhythm.type === "daily") {
    return toDateString(ref);
  }

  if (rhythm.type === "weekly") {
    const days = (rhythm.schedule.days ?? []).slice().sort((a, b) => a - b);
    if (days.length === 0) return toDateString(ref);

    // Find next (or same) day-of-week on/after ref
    for (let offset = 0; offset < 7; offset++) {
      const d = new Date(refYear, refMonth, refDay + offset);
      if (days.includes(d.getDay())) return toDateString(d);
    }
    return toDateString(ref);
  }

  if (rhythm.type === "monthly") {
    const dom = rhythm.schedule.dayOfMonth ?? 1;
    if (dom >= refDay) {
      return toDateString(new Date(refYear, refMonth, dom));
    }
    return toDateString(new Date(refYear, refMonth + 1, dom));
  }

  // annual
  const month = (rhythm.schedule.month ?? 1) - 1;
  const day = rhythm.schedule.day ?? 1;
  const thisYear = new Date(refYear, month, day);
  if (thisYear >= new Date(refYear, refMonth, refDay)) {
    return toDateString(thisYear);
  }
  return toDateString(new Date(refYear + 1, month, day));
}

export function isDue(rhythm: Rhythm, onDate: Date): boolean {
  if (!rhythm.active) return false;

  const y = onDate.getFullYear();
  const m = onDate.getMonth();
  const d = onDate.getDate();
  const dow = onDate.getDay();

  if (rhythm.type === "daily") {
    return true;
  }

  if (rhythm.type === "weekly") {
    return (rhythm.schedule.days ?? []).includes(dow);
  }

  if (rhythm.type === "monthly") {
    const dom = rhythm.schedule.dayOfMonth ?? 1;
    return d === dom || d === dom - 1;
  }

  // annual: due if within 7 days before month+day
  const month = (rhythm.schedule.month ?? 1) - 1;
  const day = rhythm.schedule.day ?? 1;

  // Build candidate dates in current and next year
  const candidates = [
    new Date(y, month, day),
    new Date(y + 1, month, day),
  ];

  for (const due of candidates) {
    const windowStart = new Date(due);
    windowStart.setDate(windowStart.getDate() - 7);
    if (onDate >= windowStart && onDate <= due) return true;
  }
  return false;
}

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

function buildRRule(rhythm: Rhythm): string {
  if (rhythm.type === "daily") {
    return "RRULE:FREQ=DAILY";
  }
  if (rhythm.type === "weekly") {
    const days = (rhythm.schedule.days ?? []).map((d) => WEEKDAY_NAMES[d]).join(",");
    return `RRULE:FREQ=WEEKLY;BYDAY=${days}`;
  }
  if (rhythm.type === "monthly") {
    return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${rhythm.schedule.dayOfMonth ?? 1}`;
  }
  return `RRULE:FREQ=YEARLY;BYMONTH=${rhythm.schedule.month ?? 1};BYMONTHDAY=${rhythm.schedule.day ?? 1}`;
}

async function createCalEvent(rhythm: Rhythm): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) return null;

  try {
    const oauth2 = makeOAuth2Client();
    oauth2.setCredentials(tokens);
    const cal = google.calendar({ version: "v3", auth: oauth2 });

    const startDate = getCanonicalDueDate(rhythm, new Date());

    const resp = await cal.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: rhythm.title,
        description: rhythm.description,
        start: { date: startDate },
        end: { date: startDate },
        recurrence: [buildRRule(rhythm)],
        reminders: {
          useDefault: false,
          overrides: [{ method: "popup", minutes: rhythm.notifyMinutes }],
        },
      },
    });

    return resp.data.id ?? null;
  } catch (err) {
    console.error("[rhythms] createCalEvent error:", err);
    return null;
  }
}

async function deleteCalEvent(eventId: string): Promise<void> {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) return;

  try {
    const oauth2 = makeOAuth2Client();
    oauth2.setCredentials(tokens);
    const cal = google.calendar({ version: "v3", auth: oauth2 });
    await cal.events.delete({ calendarId: "primary", eventId });
  } catch {
    // swallow
  }
}

async function createRhythmInternal(
  body: {
    title: string;
    type: Rhythm["type"];
    schedule: Rhythm["schedule"];
    description?: string;
    notifyMinutes?: number;
    source?: Rhythm["source"];
  },
): Promise<Rhythm> {
  const rhythm: Rhythm = {
    id: crypto.randomUUID(),
    title: body.title,
    description: body.description,
    type: body.type,
    schedule: body.schedule,
    notifyMinutes: body.notifyMinutes ?? DEFAULT_NOTIFY[body.type],
    active: true,
    createdAt: new Date().toISOString(),
    source: body.source ?? "manual",
    completions: [],
  };

  const calEventId = await createCalEvent(rhythm);
  if (calEventId) rhythm.calEventId = calEventId;

  const rhythms = loadRhythms();
  rhythms.push(rhythm);
  saveRhythms(rhythms);

  return rhythm;
}

export async function createRhythmFromIngest(data: {
  title: string;
  type: Rhythm["type"];
  schedule: Rhythm["schedule"];
  description?: string;
  notifyMinutes?: number;
}): Promise<Rhythm> {
  return createRhythmInternal({ ...data, source: "ingest" });
}

export function createRhythmsRouter(): Router {
  const router = Router();

  router.get("/rhythms/due", (req: Request, res: Response) => {
    const dateParam = (req.query.date as string | undefined) ?? toDateString(new Date());
    const onDate = parseDate(dateParam);
    const rhythms = loadRhythms();

    const result: RhythmDue[] = rhythms
      .filter((r) => isDue(r, onDate))
      .map((r) => {
        const dueDate = getCanonicalDueDate(r, onDate);
        return {
          id: r.id,
          title: r.title,
          type: r.type,
          schedule: r.schedule,
          dueDate,
          completed: r.completions.includes(dueDate),
        };
      });

    res.json({ rhythms: result });
  });

  router.get("/rhythms", (_req: Request, res: Response) => {
    res.json(loadRhythms());
  });

  router.post("/rhythms", async (req: Request, res: Response) => {
    const body = req.body as {
      title?: string;
      type?: Rhythm["type"];
      schedule?: Rhythm["schedule"];
      description?: string;
      notifyMinutes?: number;
      source?: Rhythm["source"];
    };

    if (!body.title || !body.type || !body.schedule) {
      res.status(400).json({ error: "title, type, and schedule are required" });
      return;
    }

    try {
      const rhythm = await createRhythmInternal({
        title: body.title,
        type: body.type,
        schedule: body.schedule,
        description: body.description,
        notifyMinutes: body.notifyMinutes,
        source: body.source,
      });
      res.status(201).json(rhythm);
    } catch (err) {
      console.error("[rhythms] POST error:", err);
      res.status(500).json({ error: "Failed to create rhythm" });
    }
  });

  router.put("/rhythms/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const rhythms = loadRhythms();
    const idx = rhythms.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: "Rhythm not found" });
      return;
    }

    const existing = rhythms[idx];
    const body = req.body as Partial<Rhythm>;
    const scheduleChanged =
      body.schedule !== undefined &&
      JSON.stringify(body.schedule) !== JSON.stringify(existing.schedule);
    const titleChanged = body.title !== undefined && body.title !== existing.title;

    const updated: Rhythm = { ...existing, ...body, id: existing.id, createdAt: existing.createdAt };
    rhythms[idx] = updated;

    if ((scheduleChanged || titleChanged) && existing.calEventId) {
      await deleteCalEvent(existing.calEventId);
      const newEventId = await createCalEvent(updated);
      rhythms[idx].calEventId = newEventId ?? undefined;
    }

    saveRhythms(rhythms);
    res.json(rhythms[idx]);
  });

  router.delete("/rhythms/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const rhythms = loadRhythms();
    const idx = rhythms.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: "Rhythm not found" });
      return;
    }

    const [removed] = rhythms.splice(idx, 1);
    saveRhythms(rhythms);

    if (removed.calEventId) {
      await deleteCalEvent(removed.calEventId);
    }

    res.json({ ok: true });
  });

  router.post("/rhythms/:id/complete", (req: Request, res: Response) => {
    const { id } = req.params;
    const rhythms = loadRhythms();
    const idx = rhythms.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: "Rhythm not found" });
      return;
    }

    const rhythm = rhythms[idx];
    const dueDate = getCanonicalDueDate(rhythm, new Date());

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = toDateString(cutoff);

    const alreadyDone = rhythm.completions.includes(dueDate);
    const completions = (alreadyDone
      ? rhythm.completions.filter((d) => d !== dueDate)
      : Array.from(new Set([...rhythm.completions, dueDate]))
    ).filter((d) => d >= cutoffStr);

    rhythms[idx] = { ...rhythm, completions };
    saveRhythms(rhythms);
    res.json(rhythms[idx]);
  });

  return router;
}
