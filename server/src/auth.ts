import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const TOKENS_PATH = path.join(PROJECT_ROOT, "server", "data", "tokens.json");
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "server", "package.json");
const LAST_SEEN_DEBOUNCE_MS = 60_000;

const lastSeenWrites = new Map<string, number>();

export type TokenEntry = {
  id: string;
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type TokenStore = {
  tokens: TokenEntry[];
};

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export function readTokenStore(): TokenStore {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as TokenStore;
  } catch {
    return { tokens: [] };
  }
}

export function writeTokenStore(store: TokenStore): void {
  atomicWrite(TOKENS_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

export function issueToken(label = "manual"): TokenEntry {
  const store = readTokenStore();
  const entry: TokenEntry = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString("base64url"),
    label,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  };
  store.tokens.push(entry);
  writeTokenStore(store);
  return entry;
}

export function revokeToken(id: string): TokenEntry | null {
  const store = readTokenStore();
  const entry = store.tokens.find((token) => token.id === id);
  if (!entry) return null;
  if (!entry.revokedAt) entry.revokedAt = new Date().toISOString();
  writeTokenStore(store);
  return entry;
}

export function rotateAllTokens(label = "setup-initial"): TokenEntry {
  const now = new Date().toISOString();
  const store = readTokenStore();
  for (const entry of store.tokens) {
    if (!entry.revokedAt) entry.revokedAt = now;
  }
  const next: TokenEntry = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString("base64url"),
    label,
    createdAt: now,
    lastSeenAt: null,
    revokedAt: null,
  };
  store.tokens.push(next);
  writeTokenStore(store);
  return next;
}

function maybeTouchToken(tokenId: string): void {
  const now = Date.now();
  const last = lastSeenWrites.get(tokenId) ?? 0;
  if (now - last < LAST_SEEN_DEBOUNCE_MS) return;
  lastSeenWrites.set(tokenId, now);

  const store = readTokenStore();
  const entry = store.tokens.find((item) => item.id === tokenId);
  if (!entry || entry.revokedAt) return;
  entry.lastSeenAt = new Date().toISOString();
  writeTokenStore(store);
}

export function verifyToken(token: string, options?: { touch?: boolean }): TokenEntry {
  const entry = readTokenStore().tokens.find((item) => item.token === token && !item.revokedAt);
  if (!entry) throw new Error("Invalid or revoked token");
  if (options?.touch !== false) maybeTouchToken(entry.id);
  return entry;
}

export function extractBearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "Missing bearer token" });
    return;
  }

  try {
    const entry = verifyToken(token);
    (req as any).authToken = entry;
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or revoked token" });
  }
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function healthHandler(_req: Request, res: Response): void {
  res.json({ ok: true, version: getVersion() });
}

export function authVerifyHandler(req: Request, res: Response): void {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string") {
    res.status(400).json({ ok: false, error: "token is required" });
    return;
  }

  try {
    const entry = verifyToken(token);
    res.json({ ok: true, label: entry.label });
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or revoked token" });
  }
}
