import path from "node:path";
import fs from "node:fs";
import { Router, type Request, type Response } from "express";
import { getSession, promptSession, compileLLM } from "./agent.js";
import { findRelatedFromIndex } from "./knowledge/query.js";
import { registerPage, bumpReinforced as bumpMemory } from "./knowledge/memory.js";
import { createRhythmFromIngest } from "./rhythms.js";
import { jsonrepair } from "jsonrepair";

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

let ingestInProgress = false;

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


export interface TreeEntry {
  name: string;
  path: string;
  size: number;
  mtime: string;
  isDir: boolean;
}

// ── Ingest core ──────────────────────────────────────────────────────────────

interface IngestResult {
  todos_added: number;
  pages_created: string[];
  pages_updated: string[];
  project_flag: string | null;
  failSaved?: boolean;
  indexDropped?: boolean;
}

async function ingestText(
  text: string,
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

  // Load all MOC files so LLM can append to them correctly
  const MOC_IDS = ['01-identity','02-knowledge','03-projects','04-areas','05-relationships',
    '06-creativity','07-systems','08-resources','09-media','10-events','11-questions','99-archive'];
  const mocSections: string[] = [];
  for (const id of MOC_IDS) {
    const abs = path.join(VAULT_ROOT, 'wiki', `${id}.md`);
    const content = await fs.promises.readFile(abs, 'utf-8').catch(() => null);
    if (content) mocSections.push(`=== wiki/${id}.md ===\n${content}`);
  }
  const mocContext = mocSections.length > 0 ? mocSections.join('\n\n') : 'None yet.';

  const systemPrompt = `You are Keeper, a personal knowledge base compiler. Process raw input and maintain a persistent wiki using a MOC (Map of Content) architecture. Return ONLY valid JSON.

## CRITICAL PATH RULES — READ FIRST
The wiki uses ONLY these 12 numbered folders. No exceptions.

| Folder | Use for |
|--------|---------|
| wiki/01-identity/ | self, biography, values, beliefs, goals |
| wiki/02-knowledge/ | concepts, frameworks, mental models, principles, lessons |
| wiki/03-projects/ | active projects |
| wiki/04-areas/ | routines, habits, ongoing responsibilities |
| wiki/05-relationships/ | people, family, friends, social connections |
| wiki/06-creativity/ | writing, music, art, creative work |
| wiki/07-systems/ | tools, workflows, processes, configurations |
| wiki/08-resources/ | links, reading list, reference material |
| wiki/09-media/ | books, films, podcasts, shows, articles |
| wiki/10-events/ | dated events, memories, experiences |
| wiki/11-questions/ | open questions, curiosities, research threads |
| wiki/99-archive/ | deprecated or historical content |

NEVER write to wiki/food/, wiki/work/, wiki/people/, wiki/concepts/, wiki/personal/, wiki/misc/, wiki/health/, wiki/places/, wiki/media/, wiki/queries/ or any other folder name. Those do not exist.

Examples of CORRECT paths:
- A recipe → wiki/09-media/pork-belly-recipe.md  (food is media/resources)
- A person → wiki/05-relationships/levi.md
- A sermon idea → wiki/02-knowledge/open-questions-ministry.md
- A life lesson → wiki/02-knowledge/better-way-to-say-it.md
- A schedule → wiki/04-areas/connect-group-schedule.md

## Wikilinks
Always use full path format: [[wiki/XX-folder/slug|Title]]
Never use bare [[Title]]. Never use [text](path) for internal links.
Raw source: ${rawSaved ? rawFileName : 'not saved'}

## Step 1 — Extract todos
Identify action items, tasks, reminders. Return as short imperative strings.

## Step 2 — Write the wiki page
1. Check RELATED EXISTING PAGES below — if one matches, update it instead of creating a new page.
2. Otherwise create a new page at the correct wiki/XX-folder/slug.md path.

Page format:
# Page Title

One-paragraph summary.

## Section

Content with [[wiki/XX-folder/slug|Linked Term]] wikilinks.

## Related
- [[wiki/XX-folder/other|Related Page]]

## Sources
- [[raw/filename|Source: YYYY-MM-DD]]

## Step 3 — Update the MOC file
The MOC files are provided below under CURRENT MOC FILES. For the category you used:
- Take the FULL current content of that MOC file
- Add a new line under ## Pages: \`- [[wiki/XX-folder/slug|Title]] — one-line summary\`
- Include the complete updated MOC content in your writes

## Step 4 — Update _index.md
Always include wiki/_index.md. Add the new page under the correct ## Category heading.
Format: \`- [[wiki/XX-folder/slug|Page Title]] — one-line summary\`
Include ALL existing entries from the current index plus new ones.

Return ONLY this JSON (no markdown fences, no other text):
{"todos":[],"writes":[{"path":"wiki/XX-folder/slug.md","content":"..."},{"path":"wiki/XX-folder.md","content":"full updated MOC"},{"path":"wiki/_index.md","content":"full updated index"}],"project_flag":null,"rhythms":[]}

## Optional: Extract rhythms
Only include a "rhythms" entry if the text clearly implies a RECURRING personal commitment (weekly, monthly, or annual). Vague or one-off mentions do NOT qualify.
Format:
{"title":"...","type":"weekly"|"monthly"|"annual","schedule":{"days":[0]}|{"dayOfMonth":15}|{"month":3,"day":15},"description":"optional context"}
Examples:
  "I prep sermon notes every Saturday" → weekly, days:[6]
  "First of each month I review finances" → monthly, dayOfMonth:1
  "We do Good Friday service every year" → annual, month:4, day:18
Omit "rhythms" key entirely if none found.

---
CURRENT INDEX:
${indexContent || "empty"}

---
RELATED EXISTING PAGES (update these instead of creating duplicates):
${relatedPagesSection}

---
CURRENT MOC FILES (update the relevant one in your writes):
${mocContext}

---
Known projects: ${projectNames.length > 0 ? projectNames.join(', ') : 'none'}
Today: ${today}`;

  const llmRaw = await compileLLM(systemPrompt, text);

  const saveFailedIngest = async (): Promise<boolean> => {
    try {
      const failPath = path.join(VAULT_ROOT, "raw", `_failed-ingest-${Date.now()}.txt`);
      await fs.promises.mkdir(path.dirname(failPath), { recursive: true });
      await fs.promises.writeFile(failPath, llmRaw, "utf-8");
      return true;
    } catch {
      return false;
    }
  };

  // Parse LLM response — try direct parse, then fence extraction, then jsonrepair
  let parsed: { todos?: string[]; writes?: { path: string; content: string }[]; project_flag?: string | null; rhythms?: { title: string; type: string; schedule: Record<string, unknown>; description?: string }[] };
  const tryParse = (raw: string) => {
    try { return JSON.parse(raw); } catch {}
    try { return JSON.parse(jsonrepair(raw)); } catch {}
    return null;
  };
  const directResult = tryParse(llmRaw);
  if (directResult) {
    parsed = directResult;
  } else {
    const fenceMatch = llmRaw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenceMatch ? tryParse(fenceMatch[1]) : null;
    if (candidate) {
      parsed = candidate;
    } else {
      const jsonMatch = llmRaw.match(/\{[\s\S]*\}/);
      const lastResort = jsonMatch ? tryParse(jsonMatch[0]) : null;
      if (lastResort) {
        parsed = lastResort;
      } else {
        await saveFailedIngest();
        throw new Error("LLM response could not be parsed");
      }
    }
  }

  const todos: string[] = Array.isArray(parsed.todos) ? parsed.todos.filter(t => typeof t === "string") : [];
  const writes: { path: string; content: string }[] = Array.isArray(parsed.writes) ? parsed.writes.filter(w => typeof w.path === "string" && typeof w.content === "string") : [];
  const projectFlag: string | null = typeof parsed.project_flag === "string" && parsed.project_flag !== "null" && parsed.project_flag !== "None" && parsed.project_flag.trim() !== "" && parsed.project_flag.toLowerCase() !== "n/a" ? parsed.project_flag : null;

  if (writes.length === 0) {
    return {
      todos_added: todos.length,
      pages_created: [],
      pages_updated: [],
      project_flag: projectFlag,
      failSaved: false,
    };
  }

  // Apply writes
  const pagesCreated: string[] = [];
  const pagesUpdated: string[] = [];
  let indexDropped = false;

  function countContentLines(text: string): number {
    return text.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith('<!--')).length;
  }

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

    // Safety net: protect _index.md from large drops
    if (write.path === 'wiki/_index.md') {
      let existingIndexContent: string | null = null;
      try {
        existingIndexContent = await fs.promises.readFile(abs, 'utf-8');
      } catch {
        // File doesn't exist yet — first run, skip check
      }
      if (existingIndexContent !== null) {
        const existingLines = countContentLines(existingIndexContent);
        const newLines = countContentLines(write.content);
        if (existingLines > 10 && newLines < existingLines * 0.6) {
          console.warn(`[wiki] index safety net triggered: existing=${existingLines} new=${newLines}`);
          await saveFailedIngest();
          indexDropped = true;
          continue;
        }
      }
    }

    const existed = fs.existsSync(abs);
    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, write.content, "utf-8");
      if (existed) {
        pagesUpdated.push(write.path);
        bumpMemory([write.path]).catch(() => {});
      } else {
        pagesCreated.push(write.path);
        registerPage(write.path, 0).catch(() => {});
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

  // Process any extracted rhythms
  const rhythmsRaw = Array.isArray(parsed.rhythms) ? parsed.rhythms : [];
  for (const r of rhythmsRaw) {
    if (!r.title || !r.type || !r.schedule) continue;
    try { createRhythmFromIngest(r as Parameters<typeof createRhythmFromIngest>[0]); } catch { }
  }

  return {
    todos_added: todos.length,
    pages_created: pagesCreated,
    pages_updated: pagesUpdated,
    project_flag: projectFlag,
    ...(indexDropped ? { indexDropped: true } : {}),
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

      const withPreview = req.query.preview === '1';

      const entries: TreeEntry[] = await Promise.all(
        dirents.filter((d) => !d.name.startsWith(".")).map(async (dirent) => {
          const abs = path.join(folderPath, dirent.name);
          let size = 0;
          let mtime = new Date(0).toISOString();
          let preview: string | undefined;
          try {
            const stat = await fs.promises.stat(abs);
            size = stat.size;
            mtime = stat.mtime.toISOString();
            if (withPreview && !dirent.isDirectory() && dirent.name.endsWith('.md')) {
              const raw = await fs.promises.readFile(abs, 'utf8');
              preview = raw.replace(/^#+\s+.+$/m, '').replace(/\[\[.*?\]\]/g, '').replace(/[#*`_]/g, '').trim().slice(0, 200);
            }
          } catch {
            // ignore stat errors for individual entries
          }
          return {
            name: dirent.name,
            path: `${folder}/${dirent.name}`,
            size,
            mtime,
            isDir: dirent.isDirectory(),
            ...(preview !== undefined ? { preview } : {}),
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
   * DELETE /wiki/file?path=raw/foo.md
   */
  router.delete("/wiki/file", async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "Missing path" });
      return;
    }
    const abs = resolveSafePath(filePath);
    if (!abs) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }
    try {
      await fs.promises.unlink(abs);
      res.json({ ok: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      console.error("[wiki] delete file error:", err);
      res.status(500).json({ error: "Failed to delete file" });
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
    try {
      const result = await ingestText(text, typeof existingRawPath === 'string' ? existingRawPath : undefined);
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
  router.post("/wiki/ingest-raw", async (req: Request, res: Response) => {
    if (ingestInProgress) {
      res.status(409).json({ error: "Ingest already in progress" });
      return;
    }
    ingestInProgress = true;
    try {
    const useStream = req.query['stream'] === '1';

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
        .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.') && !e.name.startsWith('_') && e.name !== 'README.md')
        .map(e => `raw/${e.name}`);
    } catch {
      res.status(500).json({ ok: false, error: 'Could not read raw/ directory' });
      return;
    }

    const toProcess = rawFiles.filter(f => !ingestedRaw.has(f));
    const processed: string[] = [];
    const skipped: string[] = rawFiles.filter(f => ingestedRaw.has(f));
    const errors: string[] = [];

    if (useStream) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders();
    }

    let doneCount = 0;
    const total = toProcess.length;

    for (const relPath of toProcess) {
      const abs = path.join(VAULT_ROOT, relPath);
      let content: string;
      try {
        content = await fs.promises.readFile(abs, 'utf-8');
      } catch {
        errors.push(relPath);
        doneCount++;
        if (useStream) res.write(`progress:${JSON.stringify({ done: doneCount, total, file: relPath })}\n`);
        continue;
      }
      if (!content.trim()) {
        skipped.push(relPath);
        doneCount++;
        if (useStream) res.write(`progress:${JSON.stringify({ done: doneCount, total, file: relPath })}\n`);
        continue;
      }

      try {
        await ingestText(content, relPath);
        processed.push(relPath);
      } catch (err) {
        console.error(`[wiki] ingest-raw error for ${relPath}:`, err);
        errors.push(relPath);
      }
      doneCount++;
      if (useStream) res.write(`progress:${JSON.stringify({ done: doneCount, total, file: relPath })}\n`);
    }

    const result = { ok: true, processed, skipped, errors };
    if (useStream) {
      res.write(`done:${JSON.stringify(result)}\n`);
      res.end();
    } else {
      res.json(result);
    }
    } finally {
      ingestInProgress = false;
    }
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
        .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.') && !e.name.startsWith('_') && e.name !== 'README.md')
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
- Categories (numbered folders): 01-identity, 02-knowledge, 03-projects, 04-areas, 05-relationships, 06-creativity, 07-systems, 08-resources, 09-media, 10-events, 11-questions, 99-archive
- MOC files (wiki/XX-name.md) should exist for each category and link to all pages in that folder

Write findings to wiki/.vault-health.md. Header with today's date. Bullet points per category. Skip categories with nothing to report. End with a short list of suggested next ingests or pages to create.`
    ).catch((err: unknown) => console.error("[wiki] lint error:", err));
  });

  // ---------------------------------------------------------------------------
  // Helper: build a leaf node from a directory path + slug
  // ---------------------------------------------------------------------------
  async function buildLeafNode(dir: string, slug: string) {
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
    const name = slug.split("/").pop()!.replace(/-/g, " ");
    return { type: "leaf" as const, slug, name, preview, lastUpdated, fileCount };
  }

  // ---------------------------------------------------------------------------
  // Helper: build the project tree (one level of containers, leaves at root)
  // ---------------------------------------------------------------------------
  async function buildProjectTree(projectsDir: string) {
    const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    const topLevel = entries.filter(
      e => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && e.name !== "general"
    );

    return Promise.all(
      topLevel.map(async (e) => {
        const dir = path.join(projectsDir, e.name);
        // A directory is a container if it has subdirs other than "convos"
        let subDirs: string[] = [];
        try {
          const children = await fs.promises.readdir(dir, { withFileTypes: true });
          subDirs = children
            .filter(c => c.isDirectory() && c.name !== "convos")
            .map(c => c.name);
        } catch {}

        const hasCanvas = fs.existsSync(path.join(dir, "canvas.json"));

        if (!hasCanvas) {
          // No canvas.json — pure organisational folder, never selectable as a project
          const children = await Promise.all(
            subDirs
              .filter(s => !s.startsWith(".") && !s.startsWith("_"))
              .map(s => buildLeafNode(path.join(dir, s), `${e.name}/${s}`))
          );
          return {
            type: "container" as const,
            isFolder: true,
            slug: e.name,
            name: e.name.replace(/-/g, " "),
            children,
          };
        } else if (subDirs.length > 0) {
          // Project that also contains child projects
          const children = await Promise.all(
            subDirs
              .filter(s => !s.startsWith(".") && !s.startsWith("_"))
              .map(s => buildLeafNode(path.join(dir, s), `${e.name}/${s}`))
          );
          return {
            type: "container" as const,
            isFolder: false,
            slug: e.name,
            name: e.name.replace(/-/g, " "),
            children,
          };
        } else {
          return buildLeafNode(dir, e.name);
        }
      })
    );
  }

  /**
   * GET /wiki/projects
   * Lists project folders with metadata (preview, fileCount, lastUpdated).
   * Returns a tree: top-level entries are either leaf nodes or container nodes.
   */
  router.get("/wiki/projects", async (_req: Request, res: Response) => {
    const projectsDir = path.join(VAULT_ROOT, "projects");
    try {
      const projects = await buildProjectTree(projectsDir);
      res.json({ ok: true, projects });
    } catch {
      res.json({ ok: true, projects: [] });
    }
  });

  /**
   * POST /wiki/projects
   * Body: { name: string, parent?: string }
   * Creates a new project folder with README.md, canvas.json, and convos/ dir.
   * If `parent` is provided, the project is created under projects/${parent}/${slug}/.
   */
  router.post("/wiki/projects", async (req: Request, res: Response) => {
    const { name, parent, type } = req.body as { name?: string; parent?: string; type?: 'project' | 'folder' };
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

    const projectsDir = path.join(VAULT_ROOT, "projects");

    // Resolve the parent directory (root or a named parent container)
    let parentDir = projectsDir;
    let parentSlug: string | undefined;
    if (parent && typeof parent === "string" && parent.trim()) {
      parentSlug = parent.trim();
      parentDir = path.join(projectsDir, parentSlug);
      if (!fs.existsSync(parentDir)) {
        res.status(400).json({ error: `Parent project '${parentSlug}' not found` });
        return;
      }
    }

    // Collision handling within the resolved parent directory
    let leafSlug = baseSlug;
    let counter = 2;
    while (fs.existsSync(path.join(parentDir, leafSlug))) {
      leafSlug = `${baseSlug}-${counter}`;
      counter++;
    }

    const slug = parentSlug ? `${parentSlug}/${leafSlug}` : leafSlug;
    const projectDir = path.join(parentDir, leafSlug);
    try {
      if (type === 'folder') {
        fs.mkdirSync(projectDir, { recursive: true });
      } else {
        fs.mkdirSync(path.join(projectDir, "convos"), { recursive: true });
        await Promise.all([
          fs.promises.writeFile(path.join(projectDir, "README.md"), `# ${name}\n\n`, "utf-8"),
          fs.promises.writeFile(path.join(projectDir, "canvas.json"), JSON.stringify({ version: 1, blocks: [] }, null, 2), "utf-8"),
          fs.promises.writeFile(path.join(projectDir, "convos", "index.json"), "[]", "utf-8"),
        ]);
      }
      res.json({ ok: true, slug, name, type: type ?? 'project' });
    } catch (err) {
      console.error("[wiki] create project error:", err);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  /**
   * PATCH /wiki/projects/*
   * Body: { name: string }
   * Renames a project: moves the folder to a new slug derived from `name`,
   * updates the README.md header, and returns the new slug.
   * Supports nested slugs like "talks/friend-zone".
   */
  router.patch("/wiki/projects/*", async (req: Request, res: Response) => {
    const oldSlug: string = req.params[0];
    const { name } = req.body as { name?: string };

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (oldSlug === "general" || oldSlug.startsWith("general/")) {
      res.status(400).json({ error: "Cannot rename general" });
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

    // Collision check within the same parent directory
    const parentDir = path.dirname(oldDir);
    const oldLeaf = path.basename(oldDir);
    const parentPrefix = oldSlug.includes("/") ? oldSlug.split("/").slice(0, -1).join("/") + "/" : "";

    let newLeaf = newBaseSlug;
    let counter = 2;
    while (newLeaf !== oldLeaf && fs.existsSync(path.join(parentDir, newLeaf))) {
      newLeaf = `${newBaseSlug}-${counter}`;
      counter++;
    }
    const newSlug = `${parentPrefix}${newLeaf}`;

    try {
      if (newLeaf !== oldLeaf) {
        await fs.promises.rename(oldDir, path.join(parentDir, newLeaf));
      }
      // Update README.md header
      const readmePath = path.join(parentDir, newLeaf, "README.md");
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
   * DELETE /wiki/projects/*
   * Permanently deletes a project folder and all its contents.
   * Supports nested slugs like "talks/friend-zone".
   */
  router.delete("/wiki/projects/*", async (req: Request, res: Response) => {
    const slug: string = req.params[0];

    if (slug === "general" || slug.startsWith("general/")) {
      res.status(400).json({ error: "Cannot delete general" });
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
    const pagePath = `wiki/11-questions/${slug}.md`;
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
      registerPage(pagePath, 1).catch(() => {});
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


    res.json({ ok: true, path: pagePath });
  });

  /**
   * GET /wiki/mocs
   * Returns metadata for all 12 MOC categories.
   * Always returns all 12 even if the MOC file / subfolder don't exist yet.
   */
  router.get("/wiki/mocs", async (_req: Request, res: Response) => {
    const MOC_DEFS = [
      { id: "01-identity",      name: "01 Identity" },
      { id: "02-knowledge",     name: "02 Knowledge" },
      { id: "03-projects",      name: "03 Projects" },
      { id: "04-areas",         name: "04 Areas" },
      { id: "05-relationships", name: "05 Relationships" },
      { id: "06-creativity",    name: "06 Creativity" },
      { id: "07-systems",       name: "07 Systems" },
      { id: "08-resources",     name: "08 Resources" },
      { id: "09-media",         name: "09 Media" },
      { id: "10-events",        name: "10 Events" },
      { id: "11-questions",     name: "11 Questions" },
      { id: "99-archive",       name: "99 Archive" },
    ];

    try {
      const mocs = await Promise.all(MOC_DEFS.map(async (def) => {
        const mocPath = path.join(VAULT_ROOT, "wiki", `${def.id}.md`);
        const subDir = path.join(VAULT_ROOT, "wiki", def.id);

        let exists = false;
        let preview = "";
        let lastUpdated = "";

        try {
          const content = await fs.promises.readFile(mocPath, "utf-8");
          const stat = await fs.promises.stat(mocPath);
          exists = true;
          lastUpdated = stat.mtime.toISOString();
          // First non-heading, non-empty line as preview
          preview = content.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "";
        } catch { /* MOC doesn't exist yet */ }

        let pageCount = 0;
        try {
          const entries = await fs.promises.readdir(subDir, { withFileTypes: true });
          pageCount = entries.filter(e => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_")).length;
        } catch { /* subfolder doesn't exist yet */ }

        return {
          id: def.id,
          name: def.name,
          path: `wiki/${def.id}.md`,
          exists,
          pageCount,
          preview,
          lastUpdated,
        };
      }));

      res.json({ ok: true, mocs });
    } catch (err) {
      console.error("[wiki] mocs error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /**
   * POST /wiki/migrate
   * One-time migration: moves old-style category folders/files into wiki/99-archive/,
   * creates MOC scaffold files for all 12 categories, and rebuilds _index.md.
   */
  router.post("/wiki/migrate", async (_req: Request, res: Response) => {
    const wikiDir = path.join(VAULT_ROOT, "wiki");
    const archiveDir = path.join(VAULT_ROOT, "wiki", "99-archive");
    const MOC_IDS = [
      "01-identity", "02-knowledge", "03-projects", "04-areas",
      "05-relationships", "06-creativity", "07-systems", "08-resources",
      "09-media", "10-events", "11-questions", "99-archive",
    ];
    const MOC_NAMES: Record<string, string> = {
      "01-identity": "01 Identity", "02-knowledge": "02 Knowledge",
      "03-projects": "03 Projects", "04-areas": "04 Areas",
      "05-relationships": "05 Relationships", "06-creativity": "06 Creativity",
      "07-systems": "07 Systems", "08-resources": "08 Resources",
      "09-media": "09 Media", "10-events": "10 Events",
      "11-questions": "11 Questions", "99-archive": "99 Archive",
    };
    const MOC_DESCS: Record<string, string> = {
      "01-identity": "Personal information, biography, values, and goals.",
      "02-knowledge": "Concepts, frameworks, mental models, and ideas.",
      "03-projects": "Active projects and their context.",
      "04-areas": "Ongoing responsibilities, routines, and life domains.",
      "05-relationships": "People, relationships, and social connections.",
      "06-creativity": "Creative work, writing, music, art, and expression.",
      "07-systems": "Workflows, tools, processes, and configurations.",
      "08-resources": "Reference material, links, and reading list.",
      "09-media": "Consumed media: books, films, podcasts, and articles.",
      "10-events": "Dated events, memories, and milestones.",
      "11-questions": "Open questions, curiosities, and research threads.",
      "99-archive": "Archived, deprecated, or historical content.",
    };

    try {
      await fs.promises.mkdir(archiveDir, { recursive: true });

      // Move non-MOC entries to 99-archive
      const entries = await fs.promises.readdir(wikiDir, { withFileTypes: true });
      const moved: string[] = [];

      for (const entry of entries) {
        // Keep: _index.md, log.md, .vault-health.md, and anything matching XX-name pattern
        if (entry.name === "_index.md" || entry.name === "log.md" || entry.name.startsWith(".")) continue;
        if (/^\d{2}-/.test(entry.name)) continue; // already MOC format

        const src = path.join(wikiDir, entry.name);
        const dest = path.join(archiveDir, entry.name);
        try {
          // If dest already exists (e.g. re-running migrate), skip
          await fs.promises.access(dest);
        } catch {
          await fs.promises.rename(src, dest);
          moved.push(entry.name);
        }
      }

      // Create MOC scaffold files for any that don't exist yet
      const scaffolded: string[] = [];
      for (const id of MOC_IDS) {
        const mocPath = path.join(wikiDir, `${id}.md`);
        try {
          await fs.promises.access(mocPath);
          // Already exists — don't overwrite
        } catch {
          const name = MOC_NAMES[id];
          const desc = MOC_DESCS[id];
          const scaffold = `# ${name}\n\n${desc}\n\n## Pages\n\n*(No pages yet — use Brain Dump to add content)*\n\n## Related\n`;
          await fs.promises.writeFile(mocPath, scaffold, "utf-8");
          scaffolded.push(`wiki/${id}.md`);
        }
      }

      // Rebuild _index.md: list archived pages under ## 99 Archive, empty sections for new categories
      let archiveEntries = "";
      try {
        const archiveFiles = await fs.promises.readdir(archiveDir, { withFileTypes: true });
        const lines: string[] = [];
        for (const f of archiveFiles) {
          if (f.isFile() && f.name.endsWith(".md") && !f.name.startsWith("_")) {
            const slug = f.name.replace(".md", "");
            lines.push(`- [[wiki/99-archive/${slug}|${slug}]] — archived page`);
          } else if (f.isDirectory()) {
            // Walk one level deep
            try {
              const subFiles = await fs.promises.readdir(path.join(archiveDir, f.name), { withFileTypes: true });
              for (const sf of subFiles) {
                if (sf.isFile() && sf.name.endsWith(".md") && !sf.name.startsWith("_")) {
                  const slug = sf.name.replace(".md", "");
                  lines.push(`- [[wiki/99-archive/${f.name}/${slug}|${slug}]] — archived page`);
                }
              }
            } catch {}
          }
        }
        archiveEntries = lines.join("\n");
      } catch {}

      const newIndex = [
        "# Wiki Index",
        "",
        "Master catalog of all wiki pages.",
        "",
        ...MOC_IDS.filter(id => id !== "99-archive").map(id => [
          `## ${MOC_NAMES[id]}`,
          "",
          "",
        ].join("\n")),
        "## 99 Archive",
        "",
        archiveEntries || "*(no archived pages)*",
        "",
      ].join("\n");

      const indexPath = path.join(VAULT_ROOT, "wiki", "_index.md");
      await fs.promises.writeFile(indexPath, newIndex, "utf-8");

      // Log the migration
      try {
        const logPath = path.join(VAULT_ROOT, "wiki", "log.md");
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
        const logEntry = `\n## [${timestamp}] migrate | MOC restructure\n- Archived: ${moved.join(", ") || "nothing"}\n- Scaffolded: ${scaffolded.join(", ") || "nothing"}\n`;
        try { await fs.promises.access(logPath); } catch {
          await fs.promises.writeFile(logPath, "# Wiki Log\n\nAppend-only record of all wiki operations.\n", "utf-8");
        }
        await fs.promises.appendFile(logPath, logEntry, "utf-8");
      } catch {}

      res.json({ ok: true, moved, scaffolded });
    } catch (err) {
      console.error("[wiki] migrate error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /**
   * GET /wiki/graph
   * Walks all vault folders and returns a graph of .md files and their [[WikiLink]] connections.
   */
  router.get("/wiki/graph", async (_req, res) => {
    type Group = "wiki" | "projects" | "journal" | "raw";

    interface GraphNode {
      id: string;
      label: string;
      path: string;
      group: Group;
      linkCount: number;
    }

    interface GraphEdge {
      source: string;
      target: string;
    }

    // Recursively collect all .md files under a directory, returning vault-relative paths
    async function collectMdFiles(dir: string, vaultRelPrefix: string): Promise<string[]> {
      const results: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const relPath = `${vaultRelPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          const sub = await collectMdFiles(path.join(dir, entry.name), relPath);
          results.push(...sub);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          results.push(relPath);
        }
      }
      return results;
    }

    // Derive a human-readable label from a filename (no extension)
    function toLabel(filename: string): string {
      return filename
        .replace(/\.md$/, "")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    // Collect all nodes
    const allIds: string[] = [];
    for (const folder of ALLOWED_FOLDERS) {
      const dir = path.join(VAULT_ROOT, folder);
      const files = await collectMdFiles(dir, folder);
      allIds.push(...files);
    }

    // Build a lookup set and a normalised-key → id map for fuzzy matching
    const nodeSet = new Set(allIds);

    // normalise: strip leading slash, strip .md extension, lowercase
    function normalise(p: string): string {
      return p.replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
    }

    // Build map: normalised id → original id
    const normMap = new Map<string, string>();
    for (const id of allIds) {
      normMap.set(normalise(id), id);
    }

    // Resolve a wikilink target to a known node id, or null
    function resolveLink(target: string): string | null {
      const normTarget = normalise(target.trim());

      // 1. Exact match after normalisation
      if (normMap.has(normTarget)) return normMap.get(normTarget)!;

      // 2. Suffix match — find any id that ends with the target (handles bare slugs and partial paths)
      for (const [normId, origId] of normMap) {
        if (normId.endsWith("/" + normTarget) || normId === normTarget) {
          return origId;
        }
      }

      return null;
    }

    // Parse wikilinks and build edges; track per-node link counts
    const linkCount = new Map<string, number>(allIds.map(id => [id, 0]));
    const edges: GraphEdge[] = [];
    const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

    for (const id of allIds) {
      const abs = path.join(VAULT_ROOT, id);
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        continue;
      }

      let match: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((match = WIKILINK_RE.exec(content)) !== null) {
        const targetId = resolveLink(match[1]);
        if (targetId && targetId !== id && nodeSet.has(targetId)) {
          edges.push({ source: id, target: targetId });
          linkCount.set(id, (linkCount.get(id) ?? 0) + 1);
          linkCount.set(targetId, (linkCount.get(targetId) ?? 0) + 1);
        }
      }
    }

    // Build node list
    const nodes: GraphNode[] = allIds.map(id => {
      const topFolder = id.split("/")[0] as Group;
      const filename = path.basename(id);
      return {
        id,
        label: toLabel(filename),
        path: id,
        group: topFolder,
        linkCount: linkCount.get(id) ?? 0,
      };
    });

    res.json({ nodes, edges });
  });

  return router;
}
