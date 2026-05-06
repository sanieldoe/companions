import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");

export const CONFIG_PATH = path.join(PROJECT_ROOT, "companions.config.json");

export type PersonaKey = "mentor" | "shapeshifter" | "keeper" | "tracker";

export interface PersonaConfig {
  displayName: string;
  emoji: string;
  slot: number;
}

export interface CompanionsConfig {
  personas: Record<PersonaKey, PersonaConfig>;
  vaultPath: string;
  publicHost: string;
  port: number;
}

const DEFAULTS: CompanionsConfig = {
  personas: {
    mentor: { displayName: "Mentor", emoji: "🐸", slot: 0 },
    shapeshifter: { displayName: "Shapeshifter", emoji: "🦊", slot: 1 },
    keeper: { displayName: "Keeper", emoji: "🐝", slot: 2 },
    tracker: { displayName: "Tracker", emoji: "🐦", slot: 3 },
  },
  vaultPath: path.join(os.homedir(), "companions-vault"),
  publicHost: "localhost",
  port: 3000,
};

let _config: CompanionsConfig | null = null;

function normalize(raw: any): CompanionsConfig {
  const personas = { ...DEFAULTS.personas };

  for (const key of Object.keys(DEFAULTS.personas) as PersonaKey[]) {
    const entry = raw?.personas?.[key] ?? {};
    personas[key] = {
      displayName: entry.displayName ?? entry.name ?? DEFAULTS.personas[key].displayName,
      emoji: entry.emoji ?? DEFAULTS.personas[key].emoji,
      slot: typeof entry.slot === "number" ? entry.slot : DEFAULTS.personas[key].slot,
    };
  }

  return {
    personas,
    vaultPath: raw?.vaultPath ?? raw?.vault ?? DEFAULTS.vaultPath,
    publicHost: raw?.publicHost ?? DEFAULTS.publicHost,
    port: Number(raw?.port ?? DEFAULTS.port),
  };
}

export function getConfig(): CompanionsConfig {
  if (_config) return _config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    _config = normalize(JSON.parse(raw));
  } catch {
    _config = { ...DEFAULTS, personas: { ...DEFAULTS.personas } };
  }
  return _config;
}

export function reloadConfig(): CompanionsConfig {
  _config = null;
  return getConfig();
}

export function getPersonaName(role: PersonaKey): string {
  return getConfig().personas[role]?.displayName ?? role;
}

export function getPersonas(): Array<{ key: PersonaKey } & PersonaConfig> {
  const config = getConfig();
  return (Object.keys(config.personas) as PersonaKey[])
    .map((key) => ({ key, ...config.personas[key] }))
    .sort((a, b) => a.slot - b.slot);
}
