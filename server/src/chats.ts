import express from "express";
import fs from "fs";
import path from "path";

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

const LEGACY_CHATS_DIR = path.resolve(VAULT_ROOT, "../.companion-system/chats");

interface ConversationMeta {
  id: string;
  startedAt: number;
  title: string;
  project?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  persona?: string;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function convosDir(slug: string): string {
  return path.join(VAULT_ROOT, "projects", slug, "convos");
}

function indexPath(slug: string): string {
  return path.join(convosDir(slug), "index.json");
}

function convoPath(slug: string, id: string): string {
  return path.join(convosDir(slug), `${id}.json`);
}

// ── Index helpers ─────────────────────────────────────────────────────────────

async function readIndex(slug: string): Promise<ConversationMeta[]> {
  try {
    const raw = await fs.promises.readFile(indexPath(slug), "utf8");
    return JSON.parse(raw) as ConversationMeta[];
  } catch {
    return [];
  }
}

async function writeIndex(slug: string, index: ConversationMeta[]): Promise<void> {
  fs.mkdirSync(convosDir(slug), { recursive: true });
  await fs.promises.writeFile(indexPath(slug), JSON.stringify(index, null, 2));
}

// ── Migration ─────────────────────────────────────────────────────────────────

export async function migrateToInbox(): Promise<{ migrated: number; skipped: number }> {
  const legacyIndexFile = path.join(LEGACY_CHATS_DIR, "index.json");

  let legacyIndex: ConversationMeta[];
  try {
    const raw = await fs.promises.readFile(legacyIndexFile, "utf8");
    legacyIndex = JSON.parse(raw) as ConversationMeta[];
  } catch {
    // No legacy chats to migrate
    return { migrated: 0, skipped: 0 };
  }

  if (legacyIndex.length === 0) {
    return { migrated: 0, skipped: 0 };
  }

  fs.mkdirSync(convosDir("inbox"), { recursive: true });

  const existingIndex = await readIndex("inbox");
  const existingIds = new Set(existingIndex.map((c) => c.id));

  let migrated = 0;
  let skipped = 0;
  const newEntries: ConversationMeta[] = [];

  for (const meta of legacyIndex) {
    if (existingIds.has(meta.id)) {
      skipped++;
      continue;
    }

    const srcFile = path.join(LEGACY_CHATS_DIR, `${meta.id}.json`);
    const destFile = convoPath("inbox", meta.id);

    try {
      const content = await fs.promises.readFile(srcFile, "utf8");
      await fs.promises.writeFile(destFile, content);
      newEntries.push({ ...meta, project: "inbox" });
      migrated++;
    } catch {
      skipped++;
    }
  }

  // Merge: existing entries first, then new entries (dedup by id)
  const merged = [...existingIndex, ...newEntries];
  // Deduplicate (keep first occurrence)
  const seen = new Set<string>();
  const deduped = merged.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  await writeIndex("inbox", deduped);

  console.log(`[chats] Migration: ${migrated} migrated, ${skipped} skipped`);
  return { migrated, skipped };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createChatsRouter() {
  const router = express.Router();

  // POST /chats/migrate — must be before /chats/:id to avoid param capture
  router.post("/chats/migrate", async (_req, res) => {
    try {
      const result = await migrateToInbox();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[chats] Migration error:", err);
      res.status(500).json({ error: "Migration failed" });
    }
  });

  // GET /chats?project=<slug>
  router.get("/chats", async (req, res) => {
    const slug = (req.query.project as string | undefined) ?? "inbox";
    res.json({ conversations: await readIndex(slug) });
  });

  // GET /chats/:id?project=<slug>
  router.get("/chats/:id", async (req, res) => {
    const slug = (req.query.project as string | undefined) ?? "inbox";
    const file = convoPath(slug, req.params.id);
    try {
      const raw = await fs.promises.readFile(file, "utf8");
      res.json({ messages: JSON.parse(raw) });
    } catch {
      res.json({ messages: [] });
    }
  });

  // PUT /chats/:id — body: { messages, meta, project? }
  router.put("/chats/:id", async (req, res) => {
    const { messages, meta, project } = req.body as {
      messages: Message[];
      meta: ConversationMeta;
      project?: string;
    };
    const id = req.params.id;
    const slug = project ?? "inbox";

    if (!id || !messages || !meta) {
      res.status(400).json({ error: "bad request" });
      return;
    }

    fs.mkdirSync(convosDir(slug), { recursive: true });
    await fs.promises.writeFile(convoPath(slug, id), JSON.stringify(messages, null, 2));

    const index = await readIndex(slug);
    const i = index.findIndex((c) => c.id === id);
    const enrichedMeta: ConversationMeta = { ...meta, project: slug };
    if (i >= 0) {
      index[i] = enrichedMeta;
    } else {
      index.unshift(enrichedMeta);
    }
    const capped = index.slice(0, 50);
    await writeIndex(slug, capped);

    res.json({ ok: true, conversations: capped });
  });

  // DELETE /chats/:id?project=<slug>
  router.delete("/chats/:id", async (req, res) => {
    const slug = (req.query.project as string | undefined) ?? "inbox";
    const id = req.params.id;
    try {
      await fs.promises.unlink(convoPath(slug, id));
    } catch {}
    const index = (await readIndex(slug)).filter((c) => c.id !== id);
    await writeIndex(slug, index);
    res.json({ ok: true });
  });

  // DELETE /chats?project=<slug>
  router.delete("/chats", async (req, res) => {
    const slug = (req.query.project as string | undefined) ?? "inbox";
    const index = await readIndex(slug);
    await Promise.all(
      index.map((c) => fs.promises.unlink(convoPath(slug, c.id)).catch(() => {}))
    );
    await writeIndex(slug, []);
    res.json({ ok: true });
  });

  return router;
}
