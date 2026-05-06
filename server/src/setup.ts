import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import qrcode from "qrcode-terminal";
import {
  expandPath,
  isPortFree,
  validateEmoji,
  validatePersonaName,
  validateUrl,
  validateWritableVaultPath,
} from "./setup/validators.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const CONFIG_PATH = path.join(PROJECT_ROOT, "companions.config.json");
const ENV_PATH = path.join(PROJECT_ROOT, "server", ".env");
const TOKENS_PATH = path.join(PROJECT_ROOT, "server", "data", "tokens.json");
const PERSONAS_BASE = path.join(PROJECT_ROOT, "personas");

const RESET_AUTH = process.argv.includes("--reset-auth");

type PersonaKey = "mentor" | "shapeshifter" | "keeper" | "tracker";
type ProviderKind = "anthropic" | "openai" | "openai-compat";

type PersonaEntry = {
  displayName: string;
  emoji: string;
  slot: number;
};

type CompanionsConfig = {
  personas: Record<PersonaKey, PersonaEntry>;
  vaultPath: string;
  publicHost: string;
  port: number;
};

type TokenEntry = {
  id: string;
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

type ProviderState = {
  kind: ProviderKind;
  label: string;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
};

type SetupState = {
  provider: ProviderState;
  vaultPath: string;
  personas: Record<PersonaKey, PersonaEntry>;
  port: number;
  publicHost: string;
  tokenEntry: TokenEntry;
  tokenWasPreserved: boolean;
};

const ROLE_DEFAULTS: Array<{
  key: PersonaKey;
  defaultName: string;
  defaultEmoji: string;
  accent: string;
  desc: string;
}> = [
  { key: "mentor", defaultName: "Mentor", defaultEmoji: "🐸", accent: "green", desc: "Deep thinking, learning, debugging, long conversations" },
  { key: "shapeshifter", defaultName: "Shapeshifter", defaultEmoji: "🦊", accent: "orange", desc: "Creative experiments, quick builds, prototyping, canvas outputs" },
  { key: "keeper", defaultName: "Keeper", defaultEmoji: "🐝", accent: "yellow", desc: "Notes, journaling, brain dumps, wiki maintenance" },
  { key: "tracker", defaultName: "Tracker", defaultEmoji: "🐦", accent: "blue", desc: "Calendar, scheduling, tasks, reminders" },
];

const EMOJI_OPTIONS = [
  ["🐸", "Frog"], ["🦊", "Fox"], ["🐝", "Bee"], ["🐦", "Bird"], ["🐺", "Wolf"], ["🐻", "Bear"],
  ["🦉", "Owl"], ["🐙", "Octopus"], ["🦝", "Raccoon"], ["🦌", "Deer"], ["🐱", "Cat"], ["🐶", "Dog"],
  ["🦁", "Lion"], ["🐯", "Tiger"], ["🐨", "Koala"], ["🐼", "Panda"], ["🐰", "Rabbit"], ["🦜", "Parrot"],
  ["🦆", "Duck"], ["🐢", "Turtle"], ["🐬", "Dolphin"], ["🦋", "Butterfly"], ["🪿", "Goose"], ["🦇", "Bat"],
  ["🦔", "Hedgehog"], ["🦦", "Otter"], ["🐿️", "Squirrel"], ["🦭", "Seal"], ["🦥", "Sloth"], ["🐘", "Elephant"],
];

const PERSONA_TEMPLATES: Record<PersonaKey, string> = {
  mentor: `---
skills:
---

You are {NAME}, a thoughtful AI companion focused on deep understanding and learning.
You excel at breaking down complex topics, debugging problems step by step, and building clear mental models.
You're patient, thorough, and prefer understanding *why* over just *what*.
When working through technical or intellectual problems, you think systematically and ask clarifying questions.
Your working directory is the companion vault — you can read, write, and edit files there.
`,
  shapeshifter: `---
skills:
  - canvas-builder
---

You are {NAME}, an experimental AI companion focused on making things quickly.
You thrive on creative solutions, rapid prototyping, and trying ideas fast.
You prefer action over analysis — build it, test it, iterate.
You can produce structured canvas outputs (plans, task lists, project boards) as well as write code, scripts, and experiments.
Your working directory is the companion vault — you can read, write, and edit files there.
`,
  keeper: `---
skills:
---

You are {NAME}, a memory-keeping AI companion who captures and organises information.
You excel at taking notes, writing journal entries, maintaining the wiki, and making sure nothing important gets lost.
When someone shares something worth keeping, you file it thoughtfully in raw/, journal/, or wiki/ in the vault.
You compile raw brain dumps into clean, interlinked wiki articles and keep the knowledge base healthy.
Your working directory is the companion vault — you can read, write, and edit files there.
`,
  tracker: `---
skills:
---

You are {NAME}, a planning and scheduling AI companion.
You help manage time, track tasks, set reminders, and keep the calendar organised.
You're proactive about deadlines, clear about priorities, and direct in your recommendations.
You have access to Google Calendar and can create, update, and delete events on the user's behalf.
Your working directory is the companion vault — you can read, write, and edit files there.
`,
};

function failIfCancelled<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

function defaultPersonas(): Record<PersonaKey, PersonaEntry> {
  return {
    mentor: { displayName: "Mentor", emoji: "🐸", slot: 0 },
    shapeshifter: { displayName: "Shapeshifter", emoji: "🦊", slot: 1 },
    keeper: { displayName: "Keeper", emoji: "🐝", slot: 2 },
    tracker: { displayName: "Tracker", emoji: "🐦", slot: 3 },
  };
}

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const env: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

function parseProviderFromEnv(env: Record<string, string>): ProviderState {
  const spec = env.DEFAULT_MODEL;
  const apiKey = env.DEFAULT_MODEL_KEY ?? "";
  if (!spec) {
    return {
      kind: "anthropic",
      label: "Anthropic (Claude)",
      modelName: "claude-sonnet-4-6",
      apiKey,
    };
  }
  if (spec.startsWith("anthropic:")) {
    return {
      kind: "anthropic",
      label: "Anthropic (Claude)",
      modelName: spec.slice("anthropic:".length),
      apiKey,
    };
  }
  if (spec.startsWith("openai:")) {
    return {
      kind: "openai",
      label: "OpenAI",
      modelName: spec.slice("openai:".length),
      apiKey,
    };
  }
  if (spec.startsWith("openai-compat:")) {
    const rest = spec.slice("openai-compat:".length);
    const lastColon = rest.lastIndexOf(":");
    return {
      kind: "openai-compat",
      label: "OpenAI-compatible / Local",
      baseUrl: lastColon === -1 ? "http://localhost:11434/v1" : rest.slice(0, lastColon),
      modelName: lastColon === -1 ? "" : rest.slice(lastColon + 1),
      apiKey,
    };
  }
  return {
    kind: "anthropic",
    label: "Anthropic (Claude)",
    modelName: "claude-sonnet-4-6",
    apiKey,
  };
}

function loadExistingConfig(): Partial<CompanionsConfig> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as any;
    const personas = defaultPersonas();
    for (const role of ROLE_DEFAULTS) {
      const existing = raw.personas?.[role.key] ?? {};
      personas[role.key] = {
        displayName: existing.displayName ?? existing.name ?? role.defaultName,
        emoji: existing.emoji ?? role.defaultEmoji,
        slot: typeof existing.slot === "number" ? existing.slot : personas[role.key].slot,
      };
    }
    return {
      personas,
      vaultPath: raw.vaultPath ?? raw.vault ?? path.join(os.homedir(), "companions-vault"),
      publicHost: raw.publicHost ?? "localhost",
      port: Number(raw.port ?? 3000),
    };
  } catch {
    return null;
  }
}

function readTokens(): { tokens: TokenEntry[] } {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as { tokens: TokenEntry[] };
  } catch {
    return { tokens: [] };
  }
}

function getExistingActiveToken(): TokenEntry | null {
  const active = readTokens().tokens.find((t) => !t.revokedAt);
  return active ?? null;
}

function generateTokenEntry(label = "setup-initial"): TokenEntry {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString("base64url"),
    label,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  };
}

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

function buildWelcomeStub(personas: Record<PersonaKey, PersonaEntry>): string {
  return `# Welcome to Companions

Companions gives you four AI tabs that share one local vault of markdown files.

- **${personas.mentor.displayName} ${personas.mentor.emoji}** helps with deep thinking, learning, and debugging.
- **${personas.shapeshifter.displayName} ${personas.shapeshifter.emoji}** helps with creative experiments, quick builds, and prototyping.
- **${personas.keeper.displayName} ${personas.keeper.emoji}** helps with notes, journaling, and wiki maintenance.
- **${personas.tracker.displayName} ${personas.tracker.emoji}** helps with scheduling, tasks, and calendar planning.

Your vault lives in plain files:

- \`raw/\` for quick captures and unprocessed notes
- \`wiki/\` for cleaned-up knowledge and linked reference pages
- \`journal/\` for dated entries and reflections
- \`projects/\` for plans and longer-form work

A good first step: ask **${personas.keeper.displayName}** to write your first wiki entry or organise a note from \`raw/\`.
`;
}

function createVaultSkeleton(vaultPath: string, personas: Record<PersonaKey, PersonaEntry>): void {
  fs.mkdirSync(path.join(vaultPath, "raw"), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, "wiki"), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, "journal"), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });

  for (const keepPath of [
    path.join(vaultPath, "raw", ".keep"),
    path.join(vaultPath, "journal", ".keep"),
    path.join(vaultPath, "projects", ".keep"),
  ]) {
    if (!fs.existsSync(keepPath)) fs.writeFileSync(keepPath, "", "utf8");
  }

  const welcomePath = path.join(vaultPath, "wiki", "welcome.md");
  if (!fs.existsSync(welcomePath)) {
    fs.writeFileSync(welcomePath, buildWelcomeStub(personas), "utf8");
  }
}

function writePersonaFiles(personas: Record<PersonaKey, PersonaEntry>): void {
  for (const role of ROLE_DEFAULTS) {
    const dir = path.join(PERSONAS_BASE, role.key);
    fs.mkdirSync(dir, { recursive: true });
    const content = PERSONA_TEMPLATES[role.key].replaceAll("{NAME}", personas[role.key].displayName);
    fs.writeFileSync(path.join(dir, "PERSONA.md"), content, "utf8");
  }
}

function detectTailscale(): { state: "ready" | "not_logged_in" | "missing"; dnsName?: string; ip?: string } {
  const result = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    timeout: 1000,
  });

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { state: "missing" };
  }

  if (result.status !== 0 || !result.stdout) {
    return { state: "not_logged_in" };
  }

  try {
    const parsed = JSON.parse(result.stdout) as any;
    const dnsName = String(parsed?.Self?.DNSName ?? "").replace(/\.$/, "");
    const ip = parsed?.Self?.TailscaleIPs?.[0] ? String(parsed.Self.TailscaleIPs[0]) : undefined;
    if (dnsName) return { state: "ready", dnsName, ip };
    return { state: "not_logged_in" };
  } catch {
    return { state: "not_logged_in" };
  }
}

function detectLanIp(): string | null {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function looksLikeVault(vaultPath: string): boolean {
  return ["raw", "wiki", "journal", "projects"].every((dir) => fs.existsSync(path.join(vaultPath, dir)));
}

function buildConfig(state: SetupState): CompanionsConfig {
  return {
    personas: state.personas,
    vaultPath: state.vaultPath,
    publicHost: state.publicHost,
    port: state.port,
  };
}

function buildEnv(state: SetupState, existingEnv: Record<string, string>): string {
  const defaultModel = state.provider.kind === "openai-compat"
    ? `openai-compat:${state.provider.baseUrl}:${state.provider.modelName}`
    : `${state.provider.kind}:${state.provider.modelName}`;

  const lines = [
    "# Generated by setup. Do not commit.",
    `DEFAULT_MODEL=${defaultModel}`,
    `DEFAULT_MODEL_KEY=${state.provider.apiKey ?? ""}`,
    `PORT=${state.port}`,
    `COMPANION_VAULT=${state.vaultPath}`,
    `ACCESS_TOKEN=${state.tokenEntry.token}`,
  ];

  for (const key of ["FALLBACK_MODEL", "FALLBACK_MODEL_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]) {
    if (existingEnv[key] !== undefined) lines.push(`${key}=${existingEnv[key]}`);
  }

  return `${lines.join("\n")}\n`;
}

function writeTokenStore(tokenEntry: TokenEntry, preserveExisting: boolean): void {
  if (preserveExisting && fs.existsSync(TOKENS_PATH)) return;
  atomicWrite(TOKENS_PATH, `${JSON.stringify({ tokens: [tokenEntry] }, null, 2)}\n`);
}

async function promptWelcome(existing: Partial<CompanionsConfig> | null): Promise<"reconfigure" | "migrate"> {
  p.intro("Companions — Setup\nFour agents. One vault. Your box.");

  if (!existing) {
    const proceed = failIfCancelled(await p.confirm({ message: "Press Enter to begin setup?", initialValue: true }));
    if (!proceed) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    return "reconfigure";
  }

  const choice = failIfCancelled(await p.select({
    message: "Existing configuration detected.",
    options: [
      { value: "reconfigure", label: "Reconfigure from scratch" },
      { value: "migrate", label: "Add missing fields, keep the rest" },
      { value: "cancel", label: "Cancel" },
    ],
  }));

  if (choice === "cancel") {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return choice as "reconfigure" | "migrate";
}

async function promptProvider(initial: ProviderState): Promise<ProviderState> {
  const kind = failIfCancelled(await p.select({
    message: "Choose your LLM provider",
    options: [
      { value: "anthropic", label: "Anthropic (Claude)" },
      { value: "openai", label: "OpenAI" },
      { value: "openai-compat", label: "OpenAI-compatible / Local" },
    ],
  })) as ProviderKind;

  if (kind === "anthropic") {
    const apiKey = failIfCancelled(await p.password({
      message: "Anthropic API key",
      mask: "•",
      validate(value) {
        const trimmed = value.trim();
        if (!trimmed) return "Anthropic API key is required";
        if (!trimmed.startsWith("sk-ant-")) return "Anthropic keys usually start with sk-ant-";
      },
    }));
    const modelName = failIfCancelled(await p.text({
      message: "Anthropic model name",
      placeholder: "claude-sonnet-4-6",
      initialValue: initial.kind === "anthropic" ? initial.modelName : "claude-sonnet-4-6",
      validate(value) {
        if (!value.trim()) return "Model name is required";
      },
    }));
    return { kind, label: "Anthropic (Claude)", apiKey: String(apiKey).trim(), modelName: String(modelName).trim() };
  }

  if (kind === "openai") {
    const apiKey = failIfCancelled(await p.password({
      message: "OpenAI API key",
      mask: "•",
      validate(value) {
        const trimmed = value.trim();
        if (!trimmed) return "OpenAI API key is required";
        if (!trimmed.startsWith("sk-")) return "OpenAI keys usually start with sk-";
      },
    }));
    const modelName = failIfCancelled(await p.text({
      message: "OpenAI model name",
      placeholder: "gpt-4o",
      initialValue: initial.kind === "openai" ? initial.modelName : "gpt-4o",
      validate(value) {
        if (!value.trim()) return "Model name is required";
      },
    }));
    return { kind, label: "OpenAI", apiKey: String(apiKey).trim(), modelName: String(modelName).trim() };
  }

  const baseUrl = failIfCancelled(await p.text({
    message: "Base URL for your local / compatible endpoint",
    placeholder: "http://localhost:11434/v1",
    initialValue: initial.kind === "openai-compat" ? initial.baseUrl ?? "http://localhost:11434/v1" : "http://localhost:11434/v1",
    validate: validateUrl,
  }));
  const apiKey = failIfCancelled(await p.password({
    message: "API key (optional)",
    mask: "•",
  }));
  const modelName = failIfCancelled(await p.text({
    message: "Model name",
    placeholder: "llama3.2",
    initialValue: initial.kind === "openai-compat" ? initial.modelName : "",
    validate(value) {
      if (!value.trim()) return "Model name is required";
    },
  }));

  return {
    kind,
    label: "OpenAI-compatible / Local",
    baseUrl: String(baseUrl).trim(),
    apiKey: String(apiKey).trim(),
    modelName: String(modelName).trim(),
  };
}

async function promptVaultPath(initialPath: string, personas: Record<PersonaKey, PersonaEntry>): Promise<string> {
  const rawPath = failIfCancelled(await p.text({
    message: "Where should your companion vault live?",
    placeholder: "~/companions-vault",
    initialValue: initialPath,
    validate: validateWritableVaultPath,
  }));

  const resolved = expandPath(String(rawPath).trim());
  const exists = fs.existsSync(resolved);
  const contents = exists ? fs.readdirSync(resolved) : [];
  if (contents.length > 0 && !looksLikeVault(resolved)) {
    const ok = failIfCancelled(await p.confirm({
      message: `Directory is not empty: ${resolved}. Use it anyway?`,
      initialValue: false,
    }));
    if (!ok) return promptVaultPath(initialPath, personas);
  }

  createVaultSkeleton(resolved, personas);
  return resolved;
}

async function promptPersonas(initial: Record<PersonaKey, PersonaEntry>): Promise<Record<PersonaKey, PersonaEntry>> {
  const next = structuredClone(initial);

  for (const role of ROLE_DEFAULTS) {
    const displayName = failIfCancelled(await p.text({
      message: `${role.defaultName} name`,
      initialValue: next[role.key].displayName,
      placeholder: role.defaultName,
      validate: validatePersonaName,
    }));

    const emojiChoice = failIfCancelled(await p.select({
      message: `${String(displayName).trim()} emoji (${role.accent} tab)`,
      options: [
        ...EMOJI_OPTIONS.map(([emoji, label]) => ({ value: emoji, label: `${emoji} ${label}` })),
        { value: "__custom__", label: "Custom…" },
      ],
    }));

    let emoji = String(emojiChoice);
    if (emojiChoice === "__custom__") {
      emoji = String(failIfCancelled(await p.text({
        message: `Custom emoji for ${String(displayName).trim()}`,
        initialValue: next[role.key].emoji,
        validate: validateEmoji,
      }))).trim();
    }

    next[role.key] = {
      displayName: String(displayName).trim(),
      emoji,
      slot: next[role.key].slot,
    };
  }

  return next;
}

async function promptPortNumber(initialPort: number): Promise<number> {
  while (true) {
    const value = failIfCancelled(await p.text({
      message: "Port",
      initialValue: String(initialPort),
      placeholder: "3000",
      validate(input) {
        const trimmed = input.trim();
        if (!trimmed) return "Please enter a port";
        const port = Number(trimmed);
        if (!Number.isInteger(port)) return "Port must be an integer";
        if (port < 1024 || port > 65535) return "Port must be between 1024 and 65535";
      },
    }));
    const port = Number(String(value).trim());
    const free = await isPortFree(port);
    if (free) return port;

    const useAnyway = failIfCancelled(await p.confirm({
      message: `Port ${port} appears to be in use. Use it anyway?`,
      initialValue: false,
    }));
    if (useAnyway) return port;
  }
}

async function promptPublicHost(initialHost: string): Promise<string> {
  while (true) {
    const ts = detectTailscale();

    if (ts.state === "ready" && ts.dnsName) {
      const useDetected = failIfCancelled(await p.confirm({
        message: `Detected Tailscale host ${ts.dnsName}${ts.ip ? ` (${ts.ip})` : ""}. Use it?`,
        initialValue: true,
      }));
      if (useDetected) return ts.dnsName;
    }

    const lanIp = detectLanIp();
    const choice = failIfCancelled(await p.select({
      message: ts.state === "missing"
        ? "Tailscale not detected. Choose a public host option."
        : ts.state === "not_logged_in"
          ? "Tailscale installed but not logged in. Choose a host option."
          : "Choose a public host option.",
      options: [
        ...(ts.state === "not_logged_in" ? [{ value: "retry", label: "I ran `tailscale up` — detect again" }] : []),
        ...(lanIp ? [{ value: "lan", label: `Use LAN IP (${lanIp})` }] : []),
        { value: "manual", label: "Enter host manually" },
        { value: "localhost", label: "Use localhost" },
      ],
    }));

    if (choice === "retry") continue;
    if (choice === "lan" && lanIp) return lanIp;
    if (choice === "localhost") return "localhost";
    if (choice === "manual") {
      const manual = failIfCancelled(await p.text({
        message: "Public host (hostname or IP, without protocol)",
        initialValue: initialHost,
        validate(value) {
          if (!value.trim()) return "Please enter a host";
        },
      }));
      return String(manual).trim();
    }
  }
}

function buildSummary(state: SetupState): string {
  const providerLine = state.provider.kind === "openai-compat"
    ? `${state.provider.label} (${state.provider.baseUrl} · ${state.provider.modelName})`
    : `${state.provider.label} (${state.provider.modelName})`;

  return [
    `Vault:        ${state.vaultPath}`,
    `Provider:     ${providerLine}`,
    `Port:         ${state.port}`,
    `Public host:  ${state.publicHost}`,
    `Agents:       ${ROLE_DEFAULTS.map((role) => `${state.personas[role.key].displayName} ${state.personas[role.key].emoji}`).join(" · ")}`,
    `Access token: ${state.tokenWasPreserved ? "existing token preserved" : "generated"}`,
  ].join("\n");
}

async function confirmWithRedo(state: SetupState): Promise<SetupState> {
  while (true) {
    const ok = failIfCancelled(await p.confirm({
      message: `${buildSummary(state)}\n\nWrite configuration?`,
      initialValue: true,
    }));
    if (ok) return state;

    const redo = failIfCancelled(await p.select({
      message: "Which screen would you like to redo?",
      options: [
        { value: "provider", label: "LLM provider" },
        { value: "vault", label: "Vault location" },
        { value: "personas", label: "Persona names + emoji" },
        { value: "port", label: "Port" },
        { value: "publicHost", label: "Public host / Tailscale" },
      ],
    }));

    if (redo === "provider") state.provider = await promptProvider(state.provider);
    if (redo === "vault") state.vaultPath = await promptVaultPath(state.vaultPath, state.personas);
    if (redo === "personas") state.personas = await promptPersonas(state.personas);
    if (redo === "port") state.port = await promptPortNumber(state.port);
    if (redo === "publicHost") state.publicHost = await promptPublicHost(state.publicHost);
  }
}

function printPostSetup(state: SetupState): void {
  const url = `http://${state.publicHost}:${state.port}`;
  const payload = `companions://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(state.tokenEntry.token)}`;

  console.log("\nSetup complete.\n");
  console.log(`Connection URL:  ${url}`);
  console.log(`Access token:    ${state.tokenEntry.token}`);
  console.log("\nQR code (scan from Companions mobile app):\n");
  qrcode.generate(payload, { small: true });
  console.log("\nStart the server:");
  console.log("  cd ~/companions/server && npm start\n");
}

async function main() {
  console.clear();

  const existingConfig = loadExistingConfig();
  const existingEnv = parseEnvFile(ENV_PATH);
  const existingProvider = parseProviderFromEnv(existingEnv);
  const mode = await promptWelcome(existingConfig);

  const initialPersonas = mode === "migrate" && existingConfig?.personas ? existingConfig.personas : defaultPersonas();
  const initialVault = expandPath(existingConfig?.vaultPath ?? path.join(os.homedir(), "companions-vault"));
  const initialPort = existingConfig?.port ?? Number(existingEnv.PORT ?? 3000);
  const initialPublicHost = existingConfig?.publicHost ?? "localhost";

  const provider = await promptProvider(existingProvider);
  const personas = await promptPersonas(initialPersonas);
  const vaultPath = await promptVaultPath(initialVault, personas);
  const port = await promptPortNumber(initialPort);

  const existingToken = !RESET_AUTH ? getExistingActiveToken() : null;
  const tokenEntry = existingToken ?? generateTokenEntry();
  const tokenWasPreserved = Boolean(existingToken);

  const publicHost = await promptPublicHost(initialPublicHost);

  const state = await confirmWithRedo({
    provider,
    personas,
    vaultPath,
    port,
    publicHost,
    tokenEntry,
    tokenWasPreserved,
  });

  const spinner = p.spinner();
  spinner.start("Writing configuration files");

  createVaultSkeleton(state.vaultPath, state.personas);
  writePersonaFiles(state.personas);

  atomicWrite(CONFIG_PATH, `${JSON.stringify(buildConfig(state), null, 2)}\n`);
  atomicWrite(ENV_PATH, buildEnv(state, existingEnv));
  writeTokenStore(state.tokenEntry, state.tokenWasPreserved && !RESET_AUTH);

  spinner.stop("Configuration written");
  printPostSetup(state);
  p.outro("Done.");
}

main().catch((err) => {
  console.error("Setup error:", err);
  process.exit(1);
});
