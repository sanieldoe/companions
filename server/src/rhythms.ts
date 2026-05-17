import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";

const VAULT_ROOT = process.env.COMPANION_VAULT ?? path.resolve(process.cwd(), "..");
const RHYTHMS_PATH = path.join(VAULT_ROOT, "tasks", "rhythms.json");

const DEFAULT_NOTIFY: Record<Rhythm["type"], number> = {
  daily: 60,
  "every-n-days": 60,
  "every-n-weeks": 1440,
  weekly: 1440,
  monthly: 4320,
  annual: 10080,
};

export interface Rhythm {
  id: string;
  title: string;
  description?: string;
  type: "daily" | "every-n-days" | "every-n-weeks" | "weekly" | "monthly" | "annual";
  schedule: {
    days?: number[];
    dayOfMonth?: number;
    month?: number;
    day?: number;
    n?: number;
  };
  notifyMinutes: number;
  active: boolean;
  createdAt: string;
  source: "manual" | "ingest";
  completions: string[];
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

  if (rhythm.type === "every-n-days" || rhythm.type === "every-n-weeks") {
    const n = rhythm.schedule.n ?? 1;
    const intervalDays = rhythm.type === "every-n-weeks" ? n * 7 : n;
    const start = parseDate(rhythm.createdAt.slice(0, 10));
    const dayMs = 86400000;
    const refMs = new Date(refYear, refMonth, refDay).getTime();
    const daysSinceStart = Math.round((refMs - start.getTime()) / dayMs);
    const remainder = daysSinceStart % intervalDays;
    const offset = remainder === 0 ? 0 : intervalDays - remainder;
    return toDateString(new Date(refYear, refMonth, refDay + offset));
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

  if (rhythm.type === "every-n-days" || rhythm.type === "every-n-weeks") {
    const n = rhythm.schedule.n ?? 1;
    const intervalDays = rhythm.type === "every-n-weeks" ? n * 7 : n;
    const start = parseDate(rhythm.createdAt.slice(0, 10));
    const dayMs = 86400000;
    const onDateTime = new Date(y, m, d).getTime();
    const daysSinceStart = Math.round((onDateTime - start.getTime()) / dayMs);
    return daysSinceStart % intervalDays === 0;
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

function createRhythmInternal(
  body: {
    title: string;
    type: Rhythm["type"];
    schedule: Rhythm["schedule"];
    description?: string;
    notifyMinutes?: number;
    source?: Rhythm["source"];
  },
): Rhythm {
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

  const rhythms = loadRhythms();
  rhythms.push(rhythm);
  saveRhythms(rhythms);

  return rhythm;
}

export function createRhythmFromIngest(data: {
  title: string;
  type: Rhythm["type"];
  schedule: Rhythm["schedule"];
  description?: string;
  notifyMinutes?: number;
}): Rhythm {
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
      const rhythm = createRhythmInternal({
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

  router.put("/rhythms/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const rhythms = loadRhythms();
    const idx = rhythms.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: "Rhythm not found" });
      return;
    }

    const existing = rhythms[idx];
    const body = req.body as Partial<Rhythm>;
    rhythms[idx] = { ...existing, ...body, id: existing.id, createdAt: existing.createdAt };

    saveRhythms(rhythms);
    res.json(rhythms[idx]);
  });

  router.delete("/rhythms/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const rhythms = loadRhythms();
    const idx = rhythms.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: "Rhythm not found" });
      return;
    }

    rhythms.splice(idx, 1);
    saveRhythms(rhythms);
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
