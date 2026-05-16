import { Router } from "express";
import type { Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";

const PERSONAS_ROOT = path.resolve(process.cwd(), "..", "personas");
const ENV_PATH = path.resolve(process.cwd(), ".env");
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", "com.companion.server.plist");

const MODES = ["mentor", "shapeshifter", "keeper", "tracker"] as const;
type Mode = (typeof MODES)[number];

const DEFAULTS: Record<Mode, { name: string; emoji: string }> = {
  mentor: { name: "Sage", emoji: "🐢" },
  shapeshifter: { name: "Creato", emoji: "🦞" },
  keeper: { name: "Loom", emoji: "🐝" },
  tracker: { name: "Tick", emoji: "🐙" },
};

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

function serializeFrontmatter(fm: Record<string, string>, body: string): string {
  const lines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${lines}\n---\n\n${body.trimStart()}`;
}

function parseEnvFile(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    map[key] = val;
  }
  return map;
}

function serializeEnvFile(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
}

export function createInstallRouter(): Router {
  const router = Router();

  // GET /install/status
  router.get("/install/status", (_req: Request, res: Response) => {
    const vault = process.env.COMPANION_VAULT;
    const secret = process.env.AUTH_SECRET;
    const configured = Boolean(vault && vault.length > 0 && secret && secret.length > 0);
    res.json({ configured });
  });

  // GET /install/personas
  router.get("/install/personas", (_req: Request, res: Response) => {
    const result = MODES.map((mode) => {
      const filePath = path.join(PERSONAS_ROOT, mode, "PERSONA.md");
      if (!fs.existsSync(filePath)) {
        return { mode, ...DEFAULTS[mode] };
      }
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const { fm } = parseFrontmatter(raw);
        return {
          mode,
          name: fm.name ?? DEFAULTS[mode].name,
          emoji: fm.emoji ?? DEFAULTS[mode].emoji,
        };
      } catch {
        return { mode, ...DEFAULTS[mode] };
      }
    });
    res.json(result);
  });

  // POST /install/validate-vault
  router.post("/install/validate-vault", (req: Request, res: Response) => {
    if (process.env.COMPANION_VAULT && process.env.AUTH_SECRET) {
      res.status(403).json({ error: "Already configured. Use the dashboard to make changes." });
      return;
    }
    const { path: vaultPath } = req.body as { path?: string };

    if (!vaultPath || vaultPath.trim().length === 0) {
      res.json({ valid: false, error: "Path required" });
      return;
    }

    const resolved = vaultPath.trim();

    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        res.json({ valid: false, error: "Path is a file, not a directory" });
        return;
      }
      const subdirs = ["wiki", "raw", "journal", "projects", "tasks"];
      const missingFolders = subdirs.filter(
        (sub) => !fs.existsSync(path.join(resolved, sub))
      );
      res.json({ valid: true, exists: true, missingFolders });
      return;
    }

    res.json({ valid: true, exists: false, missingFolders: [] });
  });

  // POST /install/apply
  router.post("/install/apply", (req: Request, res: Response) => {
    if (process.env.COMPANION_VAULT && process.env.AUTH_SECRET) {
      res.status(403).json({ error: "Already configured. Use the dashboard to make changes." });
      return;
    }
    const {
      vault,
      userName,
      authSecret,
      defaultModel,
      defaultModelKey,
      defaultModelUrl,
      personas,
      googleClientId,
      googleClientSecret,
    } = req.body as {
      vault: string;
      userName: string;
      authSecret: string;
      defaultModel: string;
      defaultModelKey?: string;
      defaultModelUrl?: string;
      personas: Array<{ mode: string; name: string; emoji: string }>;
      googleClientId?: string;
      googleClientSecret?: string;
    };

    try {
      // Step 1: Create vault dirs
      const subdirs = ["wiki", "raw", "journal", "projects", "tasks"];
      fs.mkdirSync(vault, { recursive: true });
      for (const sub of subdirs) {
        fs.mkdirSync(path.join(vault, sub), { recursive: true });
      }

      // Step 2: Write server/.env
      let envMap: Record<string, string> = {};
      if (fs.existsSync(ENV_PATH)) {
        envMap = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
      }
      envMap["COMPANION_VAULT"] = vault;
      envMap["AUTH_SECRET"] = authSecret;
      if (defaultModel) envMap["DEFAULT_MODEL"] = defaultModel;
      if (defaultModelKey) envMap["DEFAULT_MODEL_KEY"] = defaultModelKey;
      if (defaultModelUrl) envMap["DEFAULT_MODEL_URL"] = defaultModelUrl;
      if (googleClientId) envMap["GOOGLE_CLIENT_ID"] = googleClientId;
      if (googleClientSecret) envMap["GOOGLE_CLIENT_SECRET"] = googleClientSecret;
      fs.writeFileSync(ENV_PATH, serializeEnvFile(envMap), "utf8");

      // Step 3: Update launchd plist
      if (fs.existsSync(PLIST_PATH)) {
        let plist = fs.readFileSync(PLIST_PATH, "utf8");
        const plistUpdates: Record<string, string> = {
          COMPANION_VAULT: vault,
          AUTH_SECRET: authSecret,
        };
        if (defaultModel) plistUpdates["DEFAULT_MODEL"] = defaultModel;
        if (defaultModelKey) plistUpdates["DEFAULT_MODEL_KEY"] = defaultModelKey;
        if (defaultModelUrl) plistUpdates["DEFAULT_MODEL_URL"] = defaultModelUrl;
        if (googleClientId) plistUpdates["GOOGLE_CLIENT_ID"] = googleClientId;
        if (googleClientSecret) plistUpdates["GOOGLE_CLIENT_SECRET"] = googleClientSecret;

        for (const [key, value] of Object.entries(plistUpdates)) {
          const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(
            `(<key>${escapedKey}<\\/key>\\s*<string>)[^<]*(<\\/string>)`,
            "g"
          );
          plist = plist.replace(re, `$1${value}$2`);
        }
        fs.writeFileSync(PLIST_PATH, plist, "utf8");
      }

      // Step 4: Update personas
      for (const persona of personas) {
        const { mode, name, emoji } = persona;
        const filePath = path.join(PERSONAS_ROOT, mode, "PERSONA.md");
        if (!fs.existsSync(filePath)) continue;

        const raw = fs.readFileSync(filePath, "utf8");
        const { fm, body } = parseFrontmatter(raw);

        const oldName = fm.name ?? mode;
        fm.name = name;
        fm.emoji = emoji;

        // Replace old name in body text if name changed
        let newBody = body;
        if (name !== oldName) {
          const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          newBody = newBody.replace(new RegExp(escaped, "g"), name);
        }

        // Insert user name line after first # heading, but only if not already present
        if (!newBody.includes("The user's name is")) {
          const headingMatch = newBody.match(/^(#[^\n]*)/m);
          if (headingMatch && headingMatch.index !== undefined) {
            const insertPos = headingMatch.index + headingMatch[0].length;
            const userLine = `\nThe user's name is **${userName}**. Address them by name.`;
            newBody = newBody.slice(0, insertPos) + userLine + newBody.slice(insertPos);
          }
        }

        fs.writeFileSync(filePath, serializeFrontmatter(fm, newBody), "utf8");
      }

      // Step 5: Respond and restart
      res.json({ ok: true });

      setTimeout(() => {
        const uid = process.getuid?.() ?? 501;
        exec(`launchctl kickstart -k gui/${uid}/com.companion.server`, (err) => {
          if (err) console.error("[install] Failed to restart:", err);
        });
      }, 500);
    } catch (err) {
      console.error("[install] Failed to apply:", err);
      res.status(500).json({ error: "Failed to apply configuration" });
    }
  });

  // GET /install/tailscale-status
  router.get("/install/tailscale-status", (_req: Request, res: Response) => {
    const ifaces = os.networkInterfaces();
    let tailscaleIp: string | null = null;
    outer: for (const iface of Object.values(ifaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family !== "IPv4" || addr.internal) continue;
        if (addr.address.startsWith("100.")) {
          tailscaleIp = addr.address;
          break outer;
        }
      }
    }
    res.json({
      connected: !!tailscaleIp,
      ip: tailscaleIp,
      port: Number(process.env.PORT ?? 3000),
    });
  });

  // GET /download/apk
  router.get("/download/apk", (_req: Request, res: Response) => {
    const apkPaths = [
      path.resolve(
        process.cwd(),
        "..",
        "app",
        "android",
        "app",
        "build",
        "outputs",
        "apk",
        "release",
        "app-release.apk"
      ),
      path.resolve(
        process.cwd(),
        "..",
        "app",
        "android",
        "app",
        "build",
        "outputs",
        "apk",
        "debug",
        "app-debug.apk"
      ),
    ];
    const apkPath = apkPaths.find((p) => fs.existsSync(p));
    if (!apkPath) {
      res.status(404).json({ error: "APK not found. Build the app first." });
      return;
    }
    res.download(apkPath, "companion.apk");
  });

  return router;
}
