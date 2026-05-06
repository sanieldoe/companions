import path from "node:path";
import fs from "node:fs";
import { Router, type Request, type Response } from "express";
import { getSession, promptSession, getEffectiveChatModelSpec } from "./agent.js";
import { parseModelSpec } from "./models.js";
import { reindex } from "./knowledge/reindex.js";

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

const ALLOWED_FOLDERS = ["raw", "wiki", "journal", "projects"] as const;
type AllowedFolder = (typeof ALLOWED_FOLDERS)[number];

function isAllowedFolder(f: string): f is AllowedFolder {
  return (ALLOWED_FOLDERS as readonly string[]).includes(f);
}

/** Resolve and validate a user-supplied relative path. Returns absolute path or null if invalid. */
function resolveSafePath(relativePath: string): string | null {
  if (!relativePath) return null;
  const abs = path.resolve(VAULT_ROOT, relativePath);
  // Prevent traversal outside vault
  if (!abs.startsWith(VAULT_ROOT + path.sep) && abs !== VAULT_ROOT) return null;
  return abs;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDumpFilename(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const HH = pad(now.getHours());
  const MM = pad(now.getMinutes());
  return `raw/${yyyy}-${mm}-${dd}-${HH}${MM}-dump.md`;
}

/**
 * Karpathy-style page selection: scan _index.md entries for keyword overlap with input.
 * Returns up to topK wiki page paths with the highest word-overlap score.
 */
function findRelatedFromIndex(indexContent: string, inputText: string, topK: number): string[] {
  const inputWords = new Set((inputText.toLowerCase().match(/\b\w{4,}\b/g) ?? []));
  const entries: { path: string; score: number }[] = [];

  for (const line of indexContent.split('\n')) {
    const pathMatch = line.match(/\[\[([^\]|]+)/);
    if (!pathMatch) continue;
    const p = pathMatch[1].trim();
    if (!p.startsWith('wiki/') || p.includes('_index') || p.includes('log.md')) continue;
    const words = line.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
    const score = words.filter(w => {
      if (inputWords.has(w)) return true;
      if (w.length >= 5) return [...inputWords].some(iw => iw.length >= 5 && (iw.includes(w) || w.includes(iw)));
      return false;
    }).length;
    if (score > 0) entries.push({ path: p, score });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, topK).map(e => e.path);
}

export interface TreeEntry {
  name: string;
  path: string;
  size: number;
  mtime: string;
  isDir: boolean;
}

// ── LLM helper for compile (provider-aware) ─────────────────────────────────

async function callCompileLLM(
  model: ReturnType<typeof parseModelSpec>,
  apiKey: string | undefined,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  if (!model) throw new Error("No model");

  // Anthropic Messages API
  if (model.provider === "anthropic") {
    const key = apiKey ?? "";
    if (!key) throw new Error("No API key for Anthropic. Set DEFAULT_MODEL_KEY in .env");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`Anthropic API error ${resp.status}`);
    const data = await resp.json() as { content?: { text?: string }[] };
    const raw = data?.content?.[0]?.text?.trim() ?? "";
    // Anthropic may wrap JSON in a markdown code fence — extract the object
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return jsonMatch ? jsonMatch[0] : raw;
  }

  // OpenAI-compatible: standard openai, groq, openai-compat local, etc.
  if (model.api === "openai-completions" && model.baseUrl) {
    const key = (model as any).headers?.Authorization?.replace("Bearer ", "") ?? apiKey ?? "";
    const resp = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 1500,
        temperature: 0.3,
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data?.choices?.[0]?.message?.content?.trim() ?? "";
    // Strip <think>...</think> blocks emitted by reasoning models (e.g. Qwen3)
    return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  throw new Error(
    `Compile not supported for provider "${model.provider}" (api: ${model.api}). ` +
    `Use anthropic or an openai-compatible model.`
  );
}

// ── Ingest core ──────────────────────────────────────────────────────────────

interface IngestResult {
  todos_added: number;
  pages_created: string[];
  pages_updated: string[];
  project_flag: string | null;
}

async function ingestText(
  text: string,
  model: ReturnType<typeof parseModelSpec>,
  apiKey: string | undefined,
  existingRawPath?: string,  // if set, skip saving to raw/ and use this path in the log
): Promise<IngestResult> {
  // Read existing wiki index
  const indexPath = path.join(VAULT_ROOT, "wiki", "_index.md");
  let indexContent = "";
  try {
    indexContent = await fs.promises.readFile(indexPath, "utf-8");
  } catch {
    // Missing index is fine — will be created on first write
  }

  // Read project folder names for context
  const projectsDir = path.join(VAULT_ROOT, "projects");
  let projectNames: string[] = [];
  try {
    const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    projectNames = entries.filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")).map(e => e.name);
  } catch {
    // No projects dir yet — fine
  }

  const today = new Date().toISOString().slice(0, 10);

  // Save raw source for permanent preservation (or use the existing path)
  let rawFileName: string;
  let rawSaved: boolean;
  if (existingRawPath) {
    rawFileName = existingRawPath;
    rawSaved = true;
  } else {
    rawFileName = formatDumpFilename();
    const rawAbs = resolveSafePath(rawFileName);
    rawSaved = false;
    if (rawAbs) {
      try {
        await fs.promises.mkdir(path.dirname(rawAbs), { recursive: true });
        await fs.promises.writeFile(rawAbs, text, 'utf-8');
        rawSaved = true;
      } catch { /* non-fatal */ }
    }
  }

  // Find related existing wiki pages so LLM can update rather than duplicate
  // Karpathy: keyword scan _index.md, read full pages
  let relatedPagesSection = 'None found.';
  try {
    const relatedPaths = findRelatedFromIndex(indexContent, text, 4);
    const relatedPages: string[] = [];
    for (const rp of relatedPaths) {
      const abs = path.join(VAULT_ROOT, rp);
      const content = await fs.promises.readFile(abs, 'utf-8').catch(() => null);
      if (content) relatedPages.push(`=== ${rp} ===\n${content.slice(0, 3000)}`);
    }
    if (relatedPages.length > 0) relatedPagesSection = relatedPages.join('\n\n');
  } catch { /* non-fatal */ }

  const systemPrompt = `You are Keeper, a personal knowledge base compiler. Your job is to process raw input and maintain a persistent, interlinked wiki. Return ONLY valid JSON.

## Core rules
- Use [[WikiLinks]] for ALL internal references. Format: [[Page Title]] to link to wiki pages.
- Use [[raw/filename|Label]] to backlink to the raw source.
- Never use markdown links [text](path) for internal wiki references.
- The raw source has been saved as: ${rawSaved ? rawFileName : 'not saved'}

## Step 1 — Extract todos
Identify any action items, tasks, reminders, or time-sensitive items. Return as short imperative strings.

## Step 2 — Classify and write wiki content
For each knowledge item in the input:

1. Check the RELATED EXISTING PAGES provided below first.
   - If a related page exists: return UPDATED full content for that page (preserve ALL existing content, merge in new information, strengthen cross-references).
   - If no related page exists: create a new page at wiki/<category>/<slug>.md

2. Valid categories: concepts, people, health, places, media, work, personal, food, misc
   - Church/youth/Revive/worship/ministry/sermon → work
   - Food/recipe/restaurant/cooking/dish → food
   - Abstract ideas/frameworks/mental models → concepts

3. Page format:
\`\`\`
# Page Title

One-paragraph summary.

## Section Heading

Content with [[Linked Term]] wikilinks to related concepts.

## Related
- [[Related Page]]

## Sources
- [[raw/filename|Source: YYYY-MM-DD]]
\`\`\`

## Step 3 — Update _index.md
Always include wiki/_index.md in writes. Format each entry as:
\`- [[wiki/category/slug|Page Title]] — one-line summary\`

Organised under ## Category headings. Include ALL existing entries plus new ones.

Return ONLY this JSON (no other text, no markdown fences):
{
  "todos": ["action item 1", ...],
  "writes": [
    { "path": "wiki/category/slug.md", "content": "full markdown content" },
    { "path": "wiki/_index.md", "content": "full updated index" }
  ],
  "project_flag": "project-slug or null"
}

---
Existing wiki index:
${indexContent || "empty — this is the first entry"}

---
Related existing wiki pages (UPDATE these if relevant, do NOT create duplicate pages):
${relatedPagesSection}

---
Known projects: ${projectNames.length > 0 ? projectNames.join(', ') : 'none'}
Today: ${today}`;

  const llmRaw = await callCompileLLM(model, apiKey, systemPrompt, text);

  // Parse LLM response
  let parsed: { todos?: string[]; writes?: { path: string; content: string }[]; project_flag?: string | null };
  try {
    parsed = JSON.parse(llmRaw);
  } catch {
    // Try extracting JSON from a ```json block
    const fenceMatch = llmRaw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1]);
      } catch {
        throw new Error("LLM response could not be parsed");
      }
    } else {
      // Last resort: grab the first {...} object in the response
      const jsonMatch = llmRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          throw new Error("LLM response could not be parsed");
        }
      } else {
        throw new Error("LLM response could not be parsed");
      }
    }
  }

  const todos: string[] = Array.isArray(parsed.todos) ? parsed.todos.filter(t => typeof t === "string") : [];
  const writes: { path: string; content: string }[] = Array.isArray(parsed.writes) ? parsed.writes.filter(w => typeof w.path === "string" && typeof w.content === "string") : [];
  const projectFlag: string | null = typeof parsed.project_flag === "string" && parsed.project_flag !== "null" ? parsed.project_flag : null;

  // Apply writes
  const pagesCreated: string[] = [];
  const pagesUpdated: string[] = [];

  for (const write of writes) {
    // Validate path starts with wiki/
    if (!write.path.startsWith("wiki/")) {
      console.warn(`[wiki] ingest: rejected write to "${write.path}" (must start with wiki/)`);
      continue;
    }
    const abs = resolveSafePath(write.path);
    if (!abs) {
      console.warn(`[wiki] ingest: invalid path "${write.path}"`);
      continue;
    }
    const existed = fs.existsSync(abs);
    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, write.content, "utf-8");
      if (existed) {
        pagesUpdated.push(write.path);
      } else {
        pagesCreated.push(write.path);
      }
    } catch (err) {
      console.error(`[wiki] ingest: write failed for "${write.path}":`, err);
    }
  }

  // Append to wiki/log.md (append-only chronological record)
  try {
    const logPath = path.join(VAULT_ROOT, 'wiki', 'log.md');
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const sourceLabel = text.slice(0, 70).trim().replace(/\n/g, ' ');
    const logEntry = [
      ``,
      `## [${timestamp}] ingest | ${sourceLabel}`,
      `- Source: ${rawSaved ? `[[${rawFileName}]]` : 'direct (not saved to raw)'}`,
      `- Created: ${pagesCreated.length > 0 ? pagesCreated.join(', ') : 'none'}`,
      `- Updated: ${pagesUpdated.length > 0 ? pagesUpdated.join(', ') : 'none'}`,
      `- Todos extracted: ${todos.length}`,
      ``,
    ].join('\n');
    // Ensure log.md exists with header
    try { await fs.promises.access(logPath); } catch {
      await fs.promises.writeFile(logPath, '# Wiki Log\n\nAppend-only record of all wiki operations.\n', 'utf-8');
    }
    await fs.promises.appendFile(logPath, logEntry, 'utf-8');
  } catch { /* log failure is non-fatal */ }

  // Append todos to today's journal
  if (todos.length > 0) {
    const journalPath = path.join(VAULT_ROOT, "journal", `${today}.md`);
    try {
      let existing = "";
      try {
        existing = await fs.promises.readFile(journalPath, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      const todoLines = todos.map(t => `- [ ] ${t}`).join("\n") + "\n";
      let updated: string;
      if (!existing) {
        updated = `# ${today}\n\n## Tasks\n${todoLines}`;
      } else if (existing.includes("## Tasks")) {
        // Find end of the Tasks block: either the next ## heading or end of file
        const tasksIdx = existing.indexOf("## Tasks");
        const nextSection = existing.indexOf("\n##", tasksIdx + 8);
        if (nextSection !== -1) {
          // Insert before the next section
          const before = existing.slice(0, nextSection).trimEnd();
          const after = existing.slice(nextSection);
          updated = `${before}\n${todoLines}${after}`;
        } else {
          // Tasks is the last section — just append
          updated = existing.trimEnd() + "\n" + todoLines;
        }
      } else {
        updated = `${existing.trimEnd()}\n\n## Tasks\n${todoLines}`;
      }

      await fs.promises.mkdir(path.dirname(journalPath), { recursive: true });
      await fs.promises.writeFile(journalPath, updated, "utf-8");
    } catch (err) {
      console.error("[wiki] ingest: journal write failed:", err);
    }
  }

  return {
    todos_added: todos.length,
    pages_created: pagesCreated,
    pages_updated: pagesUpdated,
    project_flag: projectFlag,
  };
}

export function createWikiRouter(): Router {
  const router = Router();

  // Ensure vault folders exist
  for (const folder of ALLOWED_FOLDERS) {
    const dir = path.join(VAULT_ROOT, folder);
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * GET /wiki/tree?path=raw  (or wiki/concepts, journal, etc.)
   * Also accepts legacy ?folder= for backwards compat.
   */
  router.get("/wiki/tree", async (req: Request, res: Response) => {
    const rawPath = (req.query.path ?? req.query.folder) as string | undefined;
    if (!rawPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    // Must start with an allowed top-level folder
    const topLevel = rawPath.split("/")[0];
    if (!isAllowedFolder(topLevel)) {
      res.status(400).json({ error: "path must start with raw, wiki, or journal" });
      return;
    }

    // Resolve and validate no traversal
    const folderPath = path.resolve(VAULT_ROOT, rawPath);
    if (!folderPath.startsWith(VAULT_ROOT + path.sep) && folderPath !== VAULT_ROOT) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const folder = rawPath;

    try {
      const dirents = await fs.promises.readdir(folderPath, { withFileTypes: true });

      const entries: TreeEntry[] = await Promise.all(
        dirents.filter((d) => !d.name.startsWith(".")).map(async (dirent) => {
          const abs = path.join(folderPath, dirent.name);
          let size = 0;
          let mtime = new Date(0).toISOString();
          try {
            const stat = await fs.promises.stat(abs);
            size = stat.size;
            mtime = stat.mtime.toISOString();
          } catch {
            // ignore stat errors for individual entries
          }
          return {
            name: dirent.name,
            path: `${folder}/${dirent.name}`,
            size,
            mtime,
            isDir: dirent.isDirectory(),
          };
        })
      );

      // Sort newest first
      entries.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());

      res.json({ entries });
    } catch (err) {
      console.error("[wiki] tree error:", err);
      res.status(500).json({ error: "Failed to read directory" });
    }
  });

  /**
   * GET /wiki/file?path=raw/foo.md
   */
  router.get("/wiki/file", async (req: Request, res: Response) => {
    const relativePath = req.query.path as string;
    const abs = resolveSafePath(relativePath);

    if (!abs) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    try {
      const stat = await fs.promises.stat(abs);
      const content = await fs.promises.readFile(abs, "utf-8");
      res.json({ path: relativePath, content, mtime: stat.mtime.toISOString() });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
      } else {
        console.error("[wiki] file read error:", err);
        res.status(500).json({ error: "Failed to read file" });
      }
    }
  });

  /**
   * POST /wiki/file  body: { path: string, content: string }
   */
  router.post("/wiki/file", async (req: Request, res: Response) => {
    const { path: relativePath, content } = req.body as { path?: string; content?: string };

    if (typeof relativePath !== "string" || !relativePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }

    const abs = resolveSafePath(relativePath);
    if (!abs) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    try {
      // Ensure parent directory exists
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, "utf-8");
      res.json({ ok: true });
    } catch (err) {
      console.error("[wiki] file write error:", err);
      res.status(500).json({ error: "Failed to write file" });
    }
  });

  /**
   * POST /wiki/dump  body: { text: string }
   */
  router.post("/wiki/dump", async (req: Request, res: Response) => {
    const { text } = req.body as { text?: string };

    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (text.length > 10000) {
      res.status(400).json({ error: "text exceeds 10000 character limit" });
      return;
    }

    const relativePath = formatDumpFilename();
    const abs = resolveSafePath(relativePath);
    if (!abs) {
      res.status(500).json({ error: "Internal path resolution error" });
      return;
    }

    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, text, "utf-8");
    } catch (err) {
      console.error("[wiki] dump write error:", err);
      res.status(500).json({ error: "Failed to write dump file" });
      return;
    }

    // Brain dump is a background save — prompting the active session here
    // would inject noise into in-progress Mentor/Shapeshifter conversations.

    res.json({ ok: true, path: relativePath });
  });

  /**
   * POST /wiki/ingest  body: { text: string }
   * Takes raw text directly, sends it to the LLM for structured processing,
   * writes wiki pages, and appends todos to today's journal.
   */
  router.post("/wiki/ingest", async (req: Request, res: Response) => {
    const { text, existingRawPath } = req.body as { text?: string; existingRawPath?: string };
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ ok: false, error: "text is required" });
      return;
    }
    if (text.length > 10000) {
      res.status(400).json({ ok: false, error: "text exceeds 10000 character limit" });
      return;
    }
    const { spec, key: apiKey } = getEffectiveChatModelSpec() ?? {};
    
    let model: ReturnType<typeof parseModelSpec>;
    try {
      model = spec ? parseModelSpec(spec, apiKey) : undefined;
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Invalid model config" });
      return;
    }
    if (!model) {
      res.status(500).json({ ok: false, error: "No model configured. Set DEFAULT_MODEL in .env" });
      return;
    }
    try {
      const result = await ingestText(text, model, apiKey, typeof existingRawPath === 'string' ? existingRawPath : undefined);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[wiki] ingest error:", err);
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * POST /wiki/ingest-raw
   * Walk raw/ and ingest any files not already recorded in wiki/log.md.
   * Processes sequentially to respect LLM rate limits.
   */
  router.post("/wiki/ingest-raw", async (_req: Request, res: Response) => {
    const { spec, key: apiKey } = getEffectiveChatModelSpec() ?? {};
    
    let model: ReturnType<typeof parseModelSpec>;
    try {
      model = spec ? parseModelSpec(spec, apiKey) : undefined;
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Invalid model config" });
      return;
    }
    if (!model) {
      res.status(500).json({ ok: false, error: "No model configured. Set DEFAULT_MODEL in .env" });
      return;
    }

    // Read log.md to find already-ingested raw filenames
    const logPath = path.join(VAULT_ROOT, 'wiki', 'log.md');
    let logContent = '';
    try { logContent = await fs.promises.readFile(logPath, 'utf-8'); } catch { /* no log yet */ }

    // Extract all [[raw/...]] references from log
    const ingestedRaw = new Set<string>();
    for (const m of logContent.matchAll(/\[\[(raw\/[^\]|]+)/g)) {
      ingestedRaw.add(m[1].trim());
    }

    // Walk raw/ for markdown files
    const rawDir = path.join(VAULT_ROOT, 'raw');
    let rawFiles: string[] = [];
    try {
      const entries = await fs.promises.readdir(rawDir, { withFileTypes: true });
      rawFiles = entries
        .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.') && !e.name.startsWith('_'))
        .map(e => `raw/${e.name}`);
    } catch {
      res.status(500).json({ ok: false, error: 'Could not read raw/ directory' });
      return;
    }

    const toProcess = rawFiles.filter(f => !ingestedRaw.has(f));
    const processed: string[] = [];
    const skipped: string[] = rawFiles.filter(f => ingestedRaw.has(f));
    const errors: string[] = [];

    for (const relPath of toProcess) {
      const abs = path.join(VAULT_ROOT, relPath);
      let content: string;
      try {
        content = await fs.promises.readFile(abs, 'utf-8');
      } catch {
        errors.push(relPath);
        continue;
      }
      if (!content.trim()) { skipped.push(relPath); continue; }

      try {
        await ingestText(content, model, apiKey, relPath);
        processed.push(relPath);
      } catch (err) {
        console.error(`[wiki] ingest-raw error for ${relPath}:`, err);
        errors.push(relPath);
      }
    }

    res.json({ ok: true, processed, skipped, errors });
  });

  /**
   * GET /wiki/raw-status
   * Returns which raw/ files have and haven't been ingested yet (per wiki/log.md).
   */
  router.get("/wiki/raw-status", async (_req: Request, res: Response) => {
    // Read log to find already-ingested raw filenames
    const logPath = path.join(VAULT_ROOT, 'wiki', 'log.md');
    let logContent = '';
    try { logContent = await fs.promises.readFile(logPath, 'utf-8'); } catch { /* no log yet */ }

    const ingested = new Set<string>();
    for (const m of logContent.matchAll(/\[\[(raw\/[^\]|]+)/g)) {
      ingested.add(m[1].trim());
    }

    // Walk raw/ for markdown files
    const rawDir = path.join(VAULT_ROOT, 'raw');
    let rawFiles: string[] = [];
    try {
      const entries = await fs.promises.readdir(rawDir, { withFileTypes: true });
      rawFiles = entries
        .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
        .map(e => `raw/${e.name}`);
    } catch {
      res.json({ ok: true, total: 0, pending: [], ingested: [] });
      return;
    }

    const pending = rawFiles.filter(f => !ingested.has(f));
    const ingestedFiles = rawFiles.filter(f => ingested.has(f));

    res.json({ ok: true, total: rawFiles.length, pending, ingested: ingestedFiles });
  });

  /**
   * POST /wiki/compile
   * Kept for legacy web-client compatibility. Reads raw/ files, calls the LLM
   * to compile each into a wiki article, and writes to wiki/concepts/.
   * Raw files are never deleted — they are the immutable source of truth.
   */
  router.post("/wiki/compile", async (_req: Request, res: Response) => {
    const rawDir = path.join(VAULT_ROOT, "raw");
    const conceptsDir = path.join(VAULT_ROOT, "wiki", "concepts");

    await fs.promises.mkdir(conceptsDir, { recursive: true });

    // Read raw/ files — skip README and hidden files
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(rawDir, { withFileTypes: true });
    } catch {
      res.status(500).json({ error: "Failed to read raw/ directory" });
      return;
    }

    const rawFiles = dirents.filter(
      (d) => d.isFile() && !d.name.startsWith("_") && !d.name.startsWith(".") && d.name !== "README.md" && d.name.endsWith(".md")
    );

    if (rawFiles.length === 0) {
      res.json({ ok: true, compiled: [], message: "No files to compile" });
      return;
    }

    const { spec, key: apiKey } = getEffectiveChatModelSpec() ?? {};
    
    const model = spec ? parseModelSpec(spec, apiKey) : undefined;

    if (!model) {
      res.status(500).json({ error: "No model configured. Set DEFAULT_MODEL in .env" });
      return;
    }

    const compiled: string[] = [];
    const failed: { name: string; reason: string }[] = [];

    for (const dirent of rawFiles) {
      const rawPath = path.join(rawDir, dirent.name);
      let rawContent: string;
      try {
        rawContent = await fs.promises.readFile(rawPath, "utf-8");
      } catch {
        failed.push({ name: dirent.name, reason: "Could not read file" });
        continue;
      }

      const systemPrompt = `You are Keeper, a personal knowledge base compiler. Given a raw brain dump or note, classify it and write a clean wiki article.

Respond with ONLY a JSON object in this exact shape:
{
  "category": "<one of: concepts, people, projects, health, places, media, work, personal, food, misc>",
  "title": "<short topic name, lowercase, hyphens instead of spaces, e.g. 'react-hooks'>",
  "content": "<full markdown article>"
}

Category rules (follow strictly):
- If the note mentions youth, church, Revive, worship, ministry, sermon, or congregation → category MUST be "work"
- If the note mentions food, recipe, meal, restaurant, cooking, dish, or cuisine → category MUST be "food"
- Otherwise pick the best fit from the list

Rules for content:
- Write encyclopedia-style: clear heading, concise prose, bullet points for lists
- Start with a single # heading (the topic name, human-readable)
- Brief intro paragraph, then organised sections
- Keep the user's voice — don't over-formalise
- Sprinkle [[WikiLinks]] around key terms, people, places, and concepts so Obsidian can draw connections (e.g. [[Revive]], [[Daniel]], [[React]])
- End with: ## Source\\nCompiled from raw dump on ${new Date().toISOString().slice(0, 10)}`;

      try {
        const raw = await callCompileLLM(model, apiKey, systemPrompt, rawContent);
        if (!raw) { failed.push({ name: dirent.name, reason: "LLM returned empty response" }); continue; }

        let category = "misc";
        let title = "";
        let wikiContent = "";
        try {
          const parsed = JSON.parse(raw) as { category?: string; title?: string; content?: string };
          const VALID_CATEGORIES = ["concepts", "people", "projects", "health", "places", "media", "work", "personal", "food", "misc"];
          category = VALID_CATEGORIES.includes(parsed.category ?? "") ? (parsed.category as string) : "misc";
          // Hard override: church/youth/revive keywords always go to work
          const WORK_KEYWORDS = /\b(youth|church|revive|worship|ministry|sermon|congregation)\b/i;
          const FOOD_KEYWORDS = /\b(food|recipe|meal|restaurant|cooking|dish|cuisine)\b/i;
          if (WORK_KEYWORDS.test(rawContent)) category = "work";
          else if (FOOD_KEYWORDS.test(rawContent) && category === "misc") category = "food";
          title = (parsed.title ?? "").replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 60) || `note-${Date.now()}`;
          wikiContent = parsed.content?.trim() ?? "";
        } catch {
          failed.push({ name: dirent.name, reason: "Could not parse LLM response as JSON" });
          continue;
        }
        if (!wikiContent) { failed.push({ name: dirent.name, reason: "LLM returned empty content" }); continue; }

        const categoryDir = path.join(VAULT_ROOT, "wiki", category);
        await fs.promises.mkdir(categoryDir, { recursive: true });

        // Avoid filename collisions
        let wikiFilename = `${title}.md`;
        let wikiPath = path.join(categoryDir, wikiFilename);
        if (fs.existsSync(wikiPath)) {
          wikiFilename = `${title}-${Date.now()}.md`;
          wikiPath = path.join(categoryDir, wikiFilename);
        }

        await fs.promises.writeFile(wikiPath, wikiContent, "utf-8");

        compiled.push(`wiki/${category}/${wikiFilename}`);
      } catch (err) {
        console.error(`[wiki] compile error for ${dirent.name}:`, err);
        failed.push({ name: dirent.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Rebuild _index.md from actual wiki folder contents
    try {
      const indexPath = path.join(VAULT_ROOT, "wiki", "_index.md");
      const wikiDir = path.join(VAULT_ROOT, "wiki");
      const cats = await fs.promises.readdir(wikiDir, { withFileTypes: true });
      let index = "# Wiki Index\n";
      for (const cat of cats.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!cat.isDirectory() || cat.name.startsWith("_") || cat.name.startsWith(".")) continue;
        const catFiles = await fs.promises.readdir(path.join(wikiDir, cat.name));
        const mdFiles = catFiles.filter((f) => f.endsWith(".md") && !f.startsWith("_"));
        if (mdFiles.length === 0) continue;
        index += `\n## ${cat.name.charAt(0).toUpperCase() + cat.name.slice(1)}\n`;
        for (const f of mdFiles.sort()) {
          const pageTitle = path.basename(f, '.md').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          index += `- [[wiki/${cat.name}/${path.basename(f, '.md')}|${pageTitle}]]\n`;
        }
      }
      await fs.promises.writeFile(indexPath, index, "utf-8");
    } catch {
      // Non-fatal
    }

    res.json({ ok: true, compiled, failed });
  });

  /**
   * POST /wiki/lint
   * Fire-and-forget: starts a vault lint pass on the Keeper session.
   * The agent walks wiki/ and journal/, checks for broken links, stale pages,
   * missing concept pages, and writes findings to .vault-health.md.
   */
  router.post("/wiki/lint", (_req: Request, res: Response) => {
    res.json({ ok: true, message: "Lint pass started" });
    promptSession(
      "keeper",
      `Please run a lint pass on the vault now following the Karpathy wiki pattern.

Start by reading wiki/log.md to see what was recently ingested, then check wiki/_index.md for the full page catalog. Walk wiki/ pages and check for:

1. **Broken [[WikiLinks]]** — links to pages that don't exist in wiki/
2. **Duplicate pages** — two pages covering the same topic that should be merged
3. **Missing pages** — key concepts, people, or places mentioned in multiple pages but with no page of their own
4. **Orphan pages** — wiki pages not linked from any other page (no inbound wikilinks)
5. **Stale content** — claims that may be contradicted by newer pages
6. **Schema violations** — pages missing ## Sources, missing ## Related, or using markdown links [text](path) instead of [[WikiLinks]]

Conventions (from WIKI_SCHEMA.md):
- ALL internal links must be [[WikiLinks]] not [text](path)
- Every page should end with ## Sources and ## Related sections
- Categories: concepts, people, work, personal, food, health, places, media, queries, misc

Write findings to wiki/.vault-health.md. Header with today's date. Bullet points per category. Skip categories with nothing to report. End with a short list of suggested next ingests or pages to create.`
    ).catch((err: unknown) => console.error("[wiki] lint error:", err));
  });

  /**
   * GET /wiki/projects
   * Lists project folders with metadata (preview, fileCount, lastUpdated).
   */
  router.get("/wiki/projects", async (_req: Request, res: Response) => {
    const projectsDir = path.join(VAULT_ROOT, "projects");
    try {
      const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      const projects = await Promise.all(
        entries
          .filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && e.name !== "inbox")
          .map(async (e) => {
            const dir = path.join(projectsDir, e.name);
            const readmePath = path.join(dir, "README.md");
            let preview = "";
            let lastUpdated = "";
            let fileCount = 0;
            try {
              const content = await fs.promises.readFile(readmePath, "utf-8");
              preview = content.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "";
              const stat = await fs.promises.stat(readmePath);
              lastUpdated = stat.mtime.toISOString();
            } catch {}
            try {
              const files = await fs.promises.readdir(dir, { withFileTypes: true });
              fileCount = files.filter(f => !f.name.startsWith(".") && f.name !== "README.md").length;
            } catch {}
            return { slug: e.name, name: e.name.replace(/-/g, " "), preview, lastUpdated, fileCount };
          })
      );
      res.json({ ok: true, projects });
    } catch {
      res.json({ ok: true, projects: [] });
    }
  });

  /**
   * POST /wiki/projects
   * Body: { name: string }
   * Creates a new project folder with README.md, canvas.json, and convos/ dir.
   */
  router.post("/wiki/projects", async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Slugify: lowercase, replace non-alphanumeric runs with "-", strip leading/trailing "-"
    const baseSlug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!baseSlug) {
      res.status(400).json({ error: "name produces an empty slug" });
      return;
    }

    // Collision handling
    const projectsDir = path.join(VAULT_ROOT, "projects");
    let slug = baseSlug;
    let counter = 2;
    while (fs.existsSync(path.join(projectsDir, slug))) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    const projectDir = path.join(projectsDir, slug);
    try {
      fs.mkdirSync(path.join(projectDir, "convos"), { recursive: true });
      await fs.promises.writeFile(
        path.join(projectDir, "README.md"),
        `# ${name}\n\n`,
        "utf-8"
      );
      await fs.promises.writeFile(
        path.join(projectDir, "canvas.json"),
        JSON.stringify({ version: 1, blocks: [] }, null, 2),
        "utf-8"
      );
      res.json({ ok: true, slug, name });
    } catch (err) {
      console.error("[wiki] create project error:", err);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  /**
   * PATCH /wiki/projects/:slug
   * Body: { name: string }
   * Renames a project: moves the folder to a new slug derived from `name`,
   * updates the README.md header, and returns the new slug.
   */
  router.patch("/wiki/projects/:slug", async (req: Request, res: Response) => {
    const oldSlug = req.params.slug;
    const { name } = req.body as { name?: string };

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (oldSlug === "inbox") {
      res.status(400).json({ error: "Cannot rename inbox" });
      return;
    }

    const newBaseSlug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!newBaseSlug) {
      res.status(400).json({ error: "name produces an empty slug" });
      return;
    }

    const projectsDir = path.join(VAULT_ROOT, "projects");
    const oldDir = path.join(projectsDir, oldSlug);

    if (!fs.existsSync(oldDir)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Find a non-colliding slug
    let newSlug = newBaseSlug;
    let counter = 2;
    while (newSlug !== oldSlug && fs.existsSync(path.join(projectsDir, newSlug))) {
      newSlug = `${newBaseSlug}-${counter}`;
      counter++;
    }

    try {
      if (newSlug !== oldSlug) {
        await fs.promises.rename(oldDir, path.join(projectsDir, newSlug));
      }
      // Update README.md header
      const readmePath = path.join(projectsDir, newSlug, "README.md");
      try {
        const content = await fs.promises.readFile(readmePath, "utf-8");
        const updated = content.replace(/^#.*$/m, `# ${name.trim()}`);
        await fs.promises.writeFile(readmePath, updated, "utf-8");
      } catch { /* README may not exist */ }

      res.json({ ok: true, oldSlug, newSlug, name: name.trim() });
    } catch (err) {
      console.error("[wiki] rename project error:", err);
      res.status(500).json({ error: "Failed to rename project" });
    }
  });

  /**
   * DELETE /wiki/projects/:slug
   * Permanently deletes a project folder and all its contents.
   */
  router.delete("/wiki/projects/:slug", async (req: Request, res: Response) => {
    const slug = req.params.slug;

    if (slug === "inbox") {
      res.status(400).json({ error: "Cannot delete inbox" });
      return;
    }

    const projectDir = path.join(VAULT_ROOT, "projects", slug);

    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      await fs.promises.rm(projectDir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      console.error("[wiki] delete project error:", err);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  /**
   * GET /wiki/journal
   * Lists journal entries newest-first with a short preview.
   */
  router.get("/wiki/journal", async (_req: Request, res: Response) => {
    const journalDir = path.join(VAULT_ROOT, "journal");
    try {
      const entries = await fs.promises.readdir(journalDir, { withFileTypes: true });
      const files = entries.filter(e =>
        e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_") && e.name !== "README.md"
      );
      const items = await Promise.all(files.map(async (e) => {
        const abs = path.join(journalDir, e.name);
        let preview = "";
        try {
          const content = await fs.promises.readFile(abs, "utf-8");
          preview = content.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "";
          if (preview.length > 120) preview = preview.slice(0, 120) + "…";
        } catch {}
        const stat = await fs.promises.stat(abs).catch(() => null);
        return {
          date: e.name.replace(".md", ""),
          path: `journal/${e.name}`,
          preview,
          mtime: stat?.mtime.toISOString() ?? "",
        };
      }));
      // Sort newest first
      items.sort((a, b) => b.date.localeCompare(a.date));
      res.json({ ok: true, entries: items });
    } catch {
      res.json({ ok: true, entries: [] });
    }
  });

  /**
   * POST /wiki/save-answer
   * Body: { question: string, answer: string }
   * Saves a notable Ask answer as a wiki page in wiki/queries/.
   */
  router.post('/wiki/save-answer', async (req: Request, res: Response) => {
    const { question, answer } = req.body as { question?: string; answer?: string };
    if (typeof question !== 'string' || !question.trim() || typeof answer !== 'string' || !answer.trim()) {
      res.status(400).json({ error: 'question and answer required' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const slug = question.trim().toLowerCase().slice(0, 50)
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `query-${Date.now()}`;
    const pagePath = `wiki/queries/${slug}.md`;
    const abs = resolveSafePath(pagePath);
    if (!abs) { res.status(500).json({ error: 'path error' }); return; }

    const title = question.trim().replace(/^./, c => c.toUpperCase());
    const content = [
      `# ${title}`,
      ``,
      answer.trim(),
      ``,
      `## Source`,
      `Generated from Ask query on ${today}`,
      ``,
    ].join('\n');

    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, 'utf-8');
    } catch (err) {
      res.status(500).json({ error: 'Failed to write wiki page' });
      return;
    }

    // Append to log.md
    try {
      const logPath = path.join(VAULT_ROOT, 'wiki', 'log.md');
      const logEntry = `\n## [${timestamp}] query-saved | ${question.slice(0, 70)}\n- Saved as: [[${pagePath}]]\n`;
      try { await fs.promises.access(logPath); } catch {
        await fs.promises.writeFile(logPath, '# Wiki Log\n\nAppend-only record of all wiki operations.\n', 'utf-8');
      }
      await fs.promises.appendFile(logPath, logEntry, 'utf-8');
    } catch { /* non-fatal */ }

    // Trigger reindex so the new page is searchable
    reindex().catch(() => {});

    res.json({ ok: true, path: pagePath });
  });

  return router;
}
