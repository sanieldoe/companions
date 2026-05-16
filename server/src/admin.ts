import { Router } from "express";
import type { Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { resetSession } from "./agent.js";
import { broadcastModes } from "./gateway.js";
import type { Mode } from "./routes.js";

const VAULT_ROOT = process.env.COMPANION_VAULT ?? path.resolve(process.cwd(), "..");
const PERSONAS_ROOT = path.resolve(process.cwd(), "..", "personas");
const AUTH_SECRET = process.env.AUTH_SECRET ?? "";
const PORT = process.env.PORT ?? "3000";

export interface LogEntry {
  ts: string;
  level: "log" | "warn" | "error";
  msg: string;
}

const logBuffer: LogEntry[] = [];
const MAX_LOG = 500;
const sseClients = new Set<Response>();

export function pushLog(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: match[2] };
}

function countMdFiles(dir: string, exclude: RegExp[] = []): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countMdFiles(path.join(dir, entry.name), exclude);
    } else if (
      entry.name.endsWith(".md") &&
      !exclude.some((re) => re.test(entry.name))
    ) {
      count++;
    }
  }
  return count;
}

function detectServerIp(): string {
  const ifaces = os.networkInterfaces();
  let fallback = "";
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("100.")) return addr.address;
      if (!fallback) fallback = addr.address;
    }
  }
  return fallback || "127.0.0.1";
}

export function createAdminRouter(): Router {
  const router = Router();

  router.get("/admin/persona/:mode", (req: Request, res: Response) => {
    const { mode } = req.params;
    const filePath = path.join(PERSONAS_ROOT, mode, "PERSONA.md");
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const { fm, body } = parseFrontmatter(raw);
      res.json({
        mode,
        name: fm.name ?? mode,
        emoji: fm.emoji ?? "",
        body: body.trim(),
      });
    } catch (err) {
      console.error("[admin] Failed to read persona:", err);
      res.status(500).json({ error: "Failed to read persona" });
    }
  });

  router.put("/admin/persona/:mode", (req: Request, res: Response) => {
    const { mode } = req.params;
    const { name, emoji, body } = req.body as {
      name?: string;
      emoji?: string;
      body?: string;
    };
    const filePath = path.join(PERSONAS_ROOT, mode, "PERSONA.md");

    let existingFm: Record<string, string> = {};
    let existingBody = "";
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = parseFrontmatter(raw);
      existingFm = parsed.fm;
      existingBody = parsed.body.trim();
    }

    const oldName = existingFm.name ?? mode;
    const newName = name ?? oldName;
    const newEmoji = emoji ?? existingFm.emoji ?? "";
    // Also update old name in description field
    let description = existingFm.description ?? "";
    if (name && name !== oldName) {
      const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      description = description.replace(new RegExp(escaped, "g"), name);
    }

    // If name changed, replace all occurrences in body text
    let newBody = body ?? existingBody;
    if (name && name !== oldName) {
      const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      newBody = newBody.replace(new RegExp(escaped, "g"), name);
    }

    // If emoji changed, replace old emoji in body text and heading line
    const oldEmoji = existingFm.emoji ?? "";
    if (emoji && emoji !== oldEmoji && oldEmoji) {
      newBody = newBody.replace(new RegExp(oldEmoji, "g"), emoji);
    }

    const content = `---\nname: ${newName}\nemoji: ${newEmoji}\ndescription: ${description}\n---\n\n${newBody}`;

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
      // Bust the cached AI session so it reloads the updated persona
      resetSession(mode as Mode);
      // Push updated mode names to all connected app clients immediately
      broadcastModes();
      res.json({ ok: true });
    } catch (err) {
      console.error("[admin] Failed to write persona:", err);
      res.status(500).json({ error: "Failed to write persona" });
    }
  });

  router.get("/admin/stats", (_req: Request, res: Response) => {
    try {
      const wikiDir = path.join(VAULT_ROOT, "wiki");
      const rawDir = path.join(VAULT_ROOT, "raw");
      const journalDir = path.join(VAULT_ROOT, "journal");
      const memoryFile = path.join(wikiDir, "_memory.json");

      const wikiPages = countMdFiles(wikiDir, [/^_.+\.md$/]);
      const rawDumps = countMdFiles(rawDir, [/^_.+\.md$/, /^README\.md$/]);
      const journalDays = countMdFiles(journalDir);

      let memoryEntries = 0;
      if (fs.existsSync(memoryFile)) {
        try {
          const mem = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
          memoryEntries = Array.isArray(mem)
            ? mem.length
            : Object.keys(mem).length;
        } catch {
          // malformed json — leave at 0
        }
      }

      res.json({ vaultPath: VAULT_ROOT, wikiPages, rawDumps, journalDays, memoryEntries });
    } catch (err) {
      console.error("[admin] Failed to compute stats:", err);
      res.status(500).json({ error: "Failed to compute stats" });
    }
  });

  // ── Backup endpoints ────────────────────────────────────────────────────────

  const BACKUP_META = path.join(os.homedir(), ".companion", "backup-meta.json");

  interface BackupMeta {
    lastBackup: string;
    backupPath: string;
    count: number;
  }

  function readBackupMeta(): BackupMeta | null {
    if (!fs.existsSync(BACKUP_META)) return null;
    try {
      return JSON.parse(fs.readFileSync(BACKUP_META, "utf8")) as BackupMeta;
    } catch {
      return null;
    }
  }

  function writeBackupMeta(meta: BackupMeta): void {
    fs.mkdirSync(path.dirname(BACKUP_META), { recursive: true });
    fs.writeFileSync(BACKUP_META, JSON.stringify(meta, null, 2), "utf8");
  }

  router.get("/admin/backup/status", (_req: Request, res: Response) => {
    const meta = readBackupMeta();
    if (!meta) {
      res.json({ lastBackup: null, backupPath: null, count: 0 });
      return;
    }
    res.json({ lastBackup: meta.lastBackup, backupPath: meta.backupPath, count: meta.count });
  });

  router.post("/admin/backup", (req: Request, res: Response) => {
    const body = req.body as { destination?: string };
    const existing = readBackupMeta();
    const rawDest = body.destination?.trim()
      || existing?.backupPath
      || path.join(os.homedir(), "companion-vault-backup");
    const dest = rawDest.startsWith("~/")
      ? path.join(os.homedir(), rawDest.slice(2))
      : rawDest;

    if (!fs.existsSync(VAULT_ROOT)) {
      res.status(400).json({ ok: false, error: "Vault path does not exist" });
      return;
    }

    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch (mkErr) {
      const msg = mkErr instanceof Error ? mkErr.message : String(mkErr);
      res.status(500).json({ ok: false, error: `Failed to create destination: ${msg}` });
      return;
    }

    const child = exec(`cp -r "${VAULT_ROOT}/." "${dest}"`, { timeout: 60_000 }, (err) => {
      if (err) {
        console.error("[admin] Backup failed:", err);
        res.status(500).json({ ok: false, error: err.message });
        return;
      }
      const now = new Date().toISOString();
      const count = (existing?.count ?? 0) + 1;
      writeBackupMeta({ lastBackup: now, backupPath: dest, count });
      res.json({ ok: true, backupPath: dest, lastBackup: now });
    });

    child.on("error", (err) => {
      console.error("[admin] Backup spawn error:", err);
      // response may already be sent by exec callback — guard with headersSent
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  });

  router.put("/admin/vault", (req: Request, res: Response) => {
    const { path: newVaultRaw } = req.body as { path: string };
    if (!newVaultRaw?.trim()) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const newVault = newVaultRaw.trim().startsWith("~/")
      ? path.join(os.homedir(), newVaultRaw.trim().slice(2))
      : newVaultRaw.trim();

    // Create if missing
    try {
      fs.mkdirSync(newVault, { recursive: true });
      for (const sub of ["wiki", "raw", "journal", "projects", "tasks"]) {
        fs.mkdirSync(path.join(newVault, sub), { recursive: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Cannot create vault at path: ${msg}` });
      return;
    }

    // Write .env
    const envPath = path.resolve(process.cwd(), ".env");
    const envMap: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0 && !line.startsWith("#")) envMap[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    envMap["COMPANION_VAULT"] = newVault;
    fs.writeFileSync(envPath, Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");

    // Update plist
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.companion.server.plist");
    if (fs.existsSync(plistPath)) {
      let xml = fs.readFileSync(plistPath, "utf8");
      xml = xml.replace(
        new RegExp(`(<key>COMPANION_VAULT<\\/key>\\s*<string>)[^<]*(</string>)`),
        `$1${newVault}$2`
      );
      fs.writeFileSync(plistPath, xml, "utf8");
    }

    res.json({ ok: true, vault: newVault });

    setTimeout(() => {
      const uid = process.getuid?.() ?? 501;
      exec(`launchctl kickstart -k gui/${uid}/com.companion.server`, (err) => {
        if (err) console.error("[admin] Failed to restart after vault change:", err);
      });
    }, 500);
  });

  router.put("/admin/backup/destination", (req: Request, res: Response) => {
    const { destination } = req.body as { destination: string };
    if (!destination?.trim()) {
      res.status(400).json({ error: "destination is required" });
      return;
    }
    const existing = readBackupMeta();
    const meta: BackupMeta = {
      lastBackup: existing?.lastBackup ?? "",
      backupPath: destination.trim(),
      count: existing?.count ?? 0,
    };
    try {
      writeBackupMeta(meta);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────

  router.get("/admin/logs", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    sseClients.add(res);

    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(keepalive);
        sseClients.delete(res);
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  });

  router.get("/admin/setup-info", (_req: Request, res: Response) => {
    const ip = detectServerIp();
    res.json({
      wsUrl: `ws://${ip}:${PORT}`,
      httpUrl: `http://${ip}:${PORT}`,
      secret: AUTH_SECRET,
    });
  });

  router.get("/admin/default-model", (_req: Request, res: Response) => {
    const raw = process.env.DEFAULT_MODEL ?? "";
    const apiKey = process.env.DEFAULT_MODEL_KEY ?? "";

    // Parse the raw DEFAULT_MODEL string into category/provider/modelId/baseUrl
    let category: "local" | "cloud" = "local";
    let provider = "omlx";
    let modelId = "";
    let baseUrl = "";

    if (raw.startsWith("anthropic:")) {
      category = "cloud"; provider = "anthropic"; modelId = raw.slice("anthropic:".length);
    } else if (raw.startsWith("openai-compat:")) {
      // format: openai-compat:<baseUrl>:<modelId>
      const rest = raw.slice("openai-compat:".length);
      const lastColon = rest.lastIndexOf(":");
      baseUrl = rest.slice(0, lastColon);
      modelId = rest.slice(lastColon + 1);
      category = "local";
      // detect provider from baseUrl port
      if (baseUrl.includes(":8000")) provider = "omlx";
      else if (baseUrl.includes(":11434")) provider = "ollama";
      else if (baseUrl.includes(":1234")) provider = "lmstudio";
      else provider = "custom";
    } else if (raw.startsWith("openai:")) {
      category = "cloud"; provider = "openai"; modelId = raw.slice("openai:".length);
    } else if (raw) {
      category = "local"; provider = "custom"; modelId = raw; baseUrl = "";
    }

    res.json({ raw, category, provider, modelId, baseUrl, apiKey });
  });

  router.put("/admin/default-model", (req: Request, res: Response) => {
    const { category, provider, modelId, baseUrl, apiKey } = req.body as {
      category: "local" | "cloud";
      provider: string;
      modelId: string;
      baseUrl?: string;
      apiKey?: string;
    };

    // Build DEFAULT_MODEL string
    let defaultModel: string;
    if (category === "cloud" && provider === "anthropic") {
      defaultModel = `anthropic:${modelId}`;
    } else if (category === "cloud" && provider === "openai") {
      defaultModel = `openai:${modelId}`;
    } else if (category === "local" && provider !== "custom") {
      defaultModel = `openai-compat:${baseUrl ?? ""}:${modelId}`;
    } else {
      defaultModel = baseUrl ? `openai-compat:${baseUrl}:${modelId}` : modelId;
    }

    // Write to .env (read-merge-write, preserve existing keys)
    const envPath = path.resolve(process.cwd(), ".env");
    const envMap: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0 && !line.startsWith("#")) {
          envMap[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
    }
    envMap["DEFAULT_MODEL"] = defaultModel;
    if (apiKey) envMap["DEFAULT_MODEL_KEY"] = apiKey;
    else delete envMap["DEFAULT_MODEL_KEY"];
    fs.writeFileSync(envPath, Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");

    // Update launchd plist if it exists
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.companion.server.plist");
    if (fs.existsSync(plistPath)) {
      let xml = fs.readFileSync(plistPath, "utf8");
      const updates: Record<string, string> = { DEFAULT_MODEL: defaultModel };
      if (apiKey) updates["DEFAULT_MODEL_KEY"] = apiKey;
      for (const [key, val] of Object.entries(updates)) {
        xml = xml.replace(
          new RegExp(`(<key>${key}<\\/key>\\s*<string>)[^<]*(</string>)`),
          `$1${val}$2`
        );
      }
      fs.writeFileSync(plistPath, xml, "utf8");
    }

    res.json({ ok: true, defaultModel });

    // Restart after response flushes
    setTimeout(() => {
      const uid = process.getuid?.() ?? 501;
      exec(`launchctl kickstart -k gui/${uid}/com.companion.server`, (err) => {
        if (err) console.error("[admin] Failed to restart:", err);
      });
    }, 500);
  });

  const repoRoot = path.resolve(process.cwd(), "..");

  function gitExec(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { cwd: repoRoot }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  router.get("/admin/version", async (_req, res) => {
    try {
      const commit = await gitExec("git rev-parse --short HEAD");
      const branch = await gitExec("git rev-parse --abbrev-ref HEAD");
      let ahead = 0, behind = 0, remoteChecked = false;
      try {
        await gitExec("git fetch origin --quiet");
        const revList = await gitExec(`git rev-list --left-right --count HEAD...origin/${branch}`);
        const [a, b] = revList.split("\t").map(Number);
        ahead = a; behind = b; remoteChecked = true;
      } catch { /* network unavailable or not tracking */ }
      res.json({ commit, branch, ahead, behind, remoteChecked });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/admin/update", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (msg: string) => res.write(`data: ${JSON.stringify({ msg })}\n\n`);

    function run(cmd: string, cwd: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = exec(cmd, { cwd });
        child.stdout?.on("data", (d: Buffer) => send(d.toString().trim()));
        child.stderr?.on("data", (d: Buffer) => send(d.toString().trim()));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Exit ${code}: ${cmd}`));
        });
      });
    }

    (async () => {
      try {
        send("Pulling latest code…");
        await run("git pull origin main", repoRoot);

        send("Installing server dependencies…");
        await run("npm install --prefer-offline", path.join(repoRoot, "server"));

        send("Building server…");
        await run("npm run build", path.join(repoRoot, "server"));

        send("Building web dashboard…");
        await run("npm run build", path.join(repoRoot, "web"));

        send("Restarting server…");
        const uid = process.getuid?.() ?? 501;
        await run(`launchctl kickstart -k gui/${uid}/com.companion.server`, repoRoot);

        send("Update complete!");
        res.write(`data: ${JSON.stringify({ msg: "__done__" })}\n\n`);
        res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ msg: `Error: ${String(err)}`, error: true })}\n\n`);
        res.write(`data: ${JSON.stringify({ msg: "__done__", error: true })}\n\n`);
        res.end();
      }
    })();
  });

  return router;
}
