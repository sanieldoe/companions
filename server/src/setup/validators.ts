import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PERSONA_NAME_RE = /^[\p{L}\p{N} _-]+$/u;
const URL_PROTOCOLS = new Set(["http:", "https:"]);

export function expandPath(input: string): string {
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  if (input === "~") return os.homedir();
  return path.resolve(input);
}

export function isSingleGrapheme(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const SegmenterCtor = Intl.Segmenter;
  if (!SegmenterCtor) return [...trimmed].length === 1;
  const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" });
  const segments = [...segmenter.segment(trimmed)];
  return segments.length === 1 && segments[0]?.segment === trimmed;
}

export function validatePersonaName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter a name";
  if (trimmed.length < 1 || trimmed.length > 32) return "Name must be 1–32 characters";
  if (!PERSONA_NAME_RE.test(trimmed)) return "Use letters, numbers, spaces, - or _";
  if (trimmed.includes("/")) return "Slashes are not allowed";
  return undefined;
}

export function validateEmoji(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter an emoji";
  if (!isSingleGrapheme(trimmed)) return "Please enter exactly one emoji / grapheme";
  return undefined;
}

export async function validatePort(value: string): Promise<string | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter a port";
  const port = Number(trimmed);
  if (!Number.isInteger(port)) return "Port must be an integer";
  if (port < 1024 || port > 65535) return "Port must be between 1024 and 65535";
  const free = await isPortFree(port);
  if (!free) return `Port ${port} is already in use`;
  return undefined;
}

export function validateUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter a URL";
  try {
    const parsed = new URL(trimmed);
    if (!URL_PROTOCOLS.has(parsed.protocol)) return "URL must start with http:// or https://";
    return undefined;
  } catch {
    return "Please enter a valid URL";
  }
}

export function validateWritableVaultPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter a vault path";
  const resolved = expandPath(trimmed);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
    return undefined;
  } catch (err) {
    return `Vault path is not writable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}
