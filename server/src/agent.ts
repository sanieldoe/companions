/**
 * agent.ts
 *
 * Pi SDK session management + personality switching.
 *
 * Each mode gets its own AgentSession with a persistent session directory at
 * ~/.companion/sessions/<mode>/. Sessions are cached and reused across switches.
 *
 * Listener model: each AgentSession has ONE persistent subscription that
 * fans out events to a per-mode Set of per-connection listeners. Connections
 * add/remove themselves from the set; no global "current listener" is kept.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { MODES, type Mode } from "./routes.js";
import { resolveModelForMode, resolveDefaultModel, resolveFallbackModel } from "./models.js";

const COMPANION_DIR = path.join(os.homedir(), ".companion");
const SESSIONS_DIR = path.join(COMPANION_DIR, "sessions");

// Vault root — same resolution as wiki.ts so the agent's cwd matches the Keeper tab
const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

// Skills live at <project-root>/skills/ — resolve from this file regardless of dist depth
const SKILLS_BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills"
);

const PERSONAS_BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../personas"
);

// Mentor and Shapeshifter share one persistent session — same conversation history,
// persona flavour is injected per-message via a [saniel]/[ruse] prefix.
export const CHAT_MODES = new Set<Mode>(["mentor", "shapeshifter"]);
const CHAT_SESSION_MODE: Mode = "mentor"; // canonical key for the shared chat session

// Per-mode session cache
const sessions = new Map<Mode, AgentSession>();

// Per-mode fan-out listener sets — one entry per connected WebSocket
const modeListeners = new Map<Mode, Set<(event: AgentSessionEvent) => void>>();
for (const m of MODES) modeListeners.set(m, new Set());

let currentMode: Mode = "mentor";
let currentSession: AgentSession | null = null;

let _fallbackActive = false;

export function isFallbackActive(): boolean {
  return _fallbackActive;
}

export async function activateFallback(): Promise<boolean> {
  if (_fallbackActive) return true;
  const fallbackModel = resolveFallbackModel();
  if (!fallbackModel) return false;

  // Swap the chat session model (Mentor/Shapeshifter share one session)
  const chatSession = sessions.get(CHAT_SESSION_MODE);
  if (!chatSession) return false;

  try {
    await chatSession.setModel(fallbackModel);
    _fallbackActive = true;
    console.log(`[agent] Fallback activated → ${fallbackModel.name}`);
    return true;
  } catch (err) {
    console.warn(`[agent] Failed to activate fallback: ${err}`);
    return false;
  }
}

const MODE_MODELS_PATH = path.join(os.homedir(), ".companion", "mode-models.json");

// Shared auth storage — created once so runtime keys are visible to all sessions
let sharedAuthStorage: ReturnType<typeof AuthStorage.create> | null = null;
let sharedModelRegistry: ReturnType<typeof ModelRegistry.create> | null = null;

export function getSharedAuthStorage(): ReturnType<typeof AuthStorage.create> {
  if (sharedAuthStorage) return sharedAuthStorage;
  const agentDir = getAgentDir();
  sharedAuthStorage = AuthStorage.create(path.join(agentDir, "auth.json"));

  const defaultKey = process.env.DEFAULT_MODEL_KEY;
  if (defaultKey) {
    sharedAuthStorage.setRuntimeApiKey("openai-compat", defaultKey);
    console.log("[agent] Registered runtime API key for openai-compat");
  }

  return sharedAuthStorage;
}

export function getSharedModelRegistry(): ReturnType<typeof ModelRegistry.create> {
  if (sharedModelRegistry) return sharedModelRegistry;
  const agentDir = getAgentDir();
  sharedModelRegistry = ModelRegistry.create(
    getSharedAuthStorage(),
    path.join(agentDir, "models.json")
  );
  return sharedModelRegistry;
}

/** Read the stored mode → model mapping from disk (returns {} if file missing). */
function readModeModels(): Record<string, { provider: string; modelId: string } | null> {
  try {
    return JSON.parse(fs.readFileSync(MODE_MODELS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Persist a mode → model assignment. */
export function writeModeModel(mode: Mode, entry: { provider: string; modelId: string } | null): void {
  const current = readModeModels();
  current[mode] = entry;
  fs.writeFileSync(MODE_MODELS_PATH, JSON.stringify(current, null, 2), "utf8");
}

/** Get the persisted model for a mode (null = use default). */
export function getModeModel(mode: Mode): { provider: string; modelId: string } | null {
  return readModeModels()[mode] ?? null;
}

/** Get the stored chat model override (null = use DEFAULT_MODEL). */
export function getChatModel(): { provider: string; modelId: string } | null {
  return readModeModels()["chat"] ?? null;
}

/**
 * Returns the effective model spec string + API key for non-Pi-SDK callers
 * (knowledge router, wiki ingest). Respects the user's chat model override.
 */
export function getEffectiveChatModelSpec(): { spec: string; key: string | undefined } | null {
  const chatModel = getChatModel();
  if (chatModel) {
    return {
      spec: `${chatModel.provider}:${chatModel.modelId}`,
      key: process.env.DEFAULT_MODEL_KEY,
    };
  }
  const spec = process.env.DEFAULT_MODEL;
  if (!spec) return null;
  return { spec, key: process.env.DEFAULT_MODEL_KEY };
}

/** Persist the chat model override (null = reset to DEFAULT_MODEL). */
export function writeChatModel(entry: { provider: string; modelId: string } | null): void {
  const current = readModeModels();
  if (entry === null) {
    delete current["chat"];
  } else {
    current["chat"] = entry;
  }
  fs.writeFileSync(MODE_MODELS_PATH, JSON.stringify(current, null, 2), "utf8");
}

/** Resolve the model for a mode: mode-models.json → env vars → undefined. */
function resolveModel(mode: Mode): Model<any> | undefined {
  if (CHAT_MODES.has(mode)) {
    // Check for a user-set chat model override before falling back to DEFAULT_MODEL
    const stored = readModeModels()["chat"];
    if (stored) {
      const found = getSharedModelRegistry().find(stored.provider, stored.modelId);
      if (found) return found;
    }
    return resolveDefaultModel();
  }

  const stored = readModeModels()[mode];
  if (stored) {
    const found = getSharedModelRegistry().find(stored.provider, stored.modelId);
    if (found) return found;
  }
  return resolveModelForMode(mode);
}

function sessionDir(mode: Mode): string {
  const dir = path.join(SESSIONS_DIR, mode);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSkillBody(mode: Mode): string {
  function readPersona(m: Mode): string {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(PERSONAS_BASE, m, "PERSONA.md"), "utf8");
    } catch {
      throw new Error(`Missing persona file for mode "${m}". Expected: ${path.join(PERSONAS_BASE, m, "PERSONA.md")}`);
    }
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const body = fmMatch ? fmMatch[2].trim() : raw.trim();
    const frontmatter = fmMatch ? fmMatch[1] : "";

    const skillsMatch = frontmatter.match(/skills:\s*\n((?:[ \t]+-[ \t]+\S+\n?)*)/);
    const skillNames = skillsMatch
      ? (skillsMatch[1].match(/\S+/g) ?? []).filter((s: string) => s !== "-")
      : [];

    const skillBodies = skillNames.map((name: string) => {
      let skillRaw: string;
      try {
        skillRaw = fs.readFileSync(path.join(SKILLS_BASE, name, "SKILL.md"), "utf8");
      } catch {
        throw new Error(`Missing skill file "${name}" referenced in ${m}'s PERSONA.md. Expected: ${path.join(SKILLS_BASE, name, "SKILL.md")}`);
      }
      return skillRaw.replace(/^---[\s\S]*?---\n?/, "").trim();
    });

    return skillBodies.length > 0
      ? `${body}\n\n---\n\n${skillBodies.join("\n\n---\n\n")}`
      : body;
  }

  // Chat session: combine both personas in one system prompt.
  // The active persona is signalled per-message with a [saniel] or [ruse] prefix.
  // /no_think disables Qwen3's chain-of-thought so it doesn't exhaust the token
  // budget before emitting tool calls.
  if (mode === CHAT_SESSION_MODE) {
    const saniel = readPersona("mentor");
    const ruse   = readPersona("shapeshifter");
    return `/no_think

You are a dual-mode AI companion. The mode for each response is indicated at the very start of the user message:
- \`[saniel]\` → respond as Mentor
- \`[ruse]\` → respond as Shapeshifter

Never mention the prefix tags. Simply read the tag, adopt that persona for your response, and strip the tag from your awareness of the message.

---

${saniel}

---

${ruse}`;
  }

  return `/no_think\n\n${readPersona(mode)}`;
}

async function buildSession(mode: Mode): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const skillBody = loadSkillBody(mode);

  const services = await createAgentSessionServices({
    cwd: VAULT_ROOT,
    agentDir,
    authStorage: getSharedAuthStorage(),
    modelRegistry: getSharedModelRegistry(),
    resourceLoaderOptions: {
      // Replace Pi's base identity entirely with the persona system prompt
      systemPromptOverride: () => skillBody,
      // No skills needed — content is the system prompt
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      // Disable all ~/.pi/agent extensions — they expect a TUI context and
      // crash the server when tool calls fire in a headless environment.
      extensionsOverride: (base) => ({ ...base, extensions: [] }),
    },
  });

  const sessionManager = SessionManager.create(sessionDir(mode));
  const model = resolveModel(mode);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    ...(model ? { model } : {}),
  });

  // One persistent subscription per session.
  // The chat session (saniel) fans out to BOTH saniel and ruse listener sets
  // so the active listener receives events regardless of which persona is selected.
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const e = event as any;
      console.log(`[agent.tool] START  tool=${e.toolName}  args=${JSON.stringify(e.args ?? {})}`);
    } else if (event.type === "tool_execution_end") {
      const e = event as any;
      console.log(`[agent.tool] END    tool=${e.toolName}  isError=${e.isError}  result=${JSON.stringify(e.result ?? "").slice(0, 200)}`);
    }

    const sets = mode === CHAT_SESSION_MODE
      ? [modeListeners.get("mentor"), modeListeners.get("shapeshifter")]
      : [modeListeners.get(mode)];
    for (const set of sets) {
      if (set) for (const listener of set) listener(event);
    }
  });

  return session;
}

async function getOrCreateSession(mode: Mode): Promise<AgentSession> {
  const existing = sessions.get(mode);
  if (existing) return existing;
  const session = await buildSession(mode);
  sessions.set(mode, session);
  return session;
}

/** Register a per-connection listener for a given mode's events. */
export function addModeListener(
  mode: Mode,
  listener: (event: AgentSessionEvent) => void
): void {
  modeListeners.get(mode)?.add(listener);
}

/** Unregister a per-connection listener. */
export function removeModeListener(
  mode: Mode,
  listener: (event: AgentSessionEvent) => void
): void {
  modeListeners.get(mode)?.delete(listener);
}

/** Initialise the agent. Call once at startup. */
export async function initAgent(mode: Mode = "mentor"): Promise<void> {
  getSharedAuthStorage();
  fs.mkdirSync(path.join(COMPANION_DIR, "projects"), { recursive: true });
  currentMode = mode;
  currentSession = await getOrCreateSession(mode);
  console.log(`[agent] Initialized with mode: ${mode}`);
}

/**
 * Switch the active personality mode.
 * Listener registration is handled by the caller (gateway) — this only
 * updates the current session reference.
 */
export async function switchMode(mode: Mode): Promise<void> {
  if (mode === currentMode) return;
  console.log(`[agent] Switching mode: ${currentMode} → ${mode}`);
  currentMode = mode;
  // Mentor and Shapeshifter share one session — no session swap needed between them
  const sessionMode = CHAT_MODES.has(mode) ? CHAT_SESSION_MODE : mode;
  currentSession = await getOrCreateSession(sessionMode);
}

export function getSession(): AgentSession {
  if (!currentSession) throw new Error("[agent] Not initialized");
  return currentSession;
}

export function getCurrentMode(): Mode {
  return currentMode;
}

/**
 * Hot-swap the model for a given mode's live session.
 * Persists the choice to mode-models.json so it survives restarts.
 * Throws if the session hasn't been created yet or auth isn't configured.
 */
export async function setSessionModel(
  mode: Mode,
  provider: string,
  modelId: string
): Promise<void> {
  if (CHAT_MODES.has(mode)) {
    throw new Error(`[agent] Chat mode "${mode}" uses DEFAULT_MODEL — per-mode model overrides are not supported`);
  }
  const session = sessions.get(mode);
  if (!session) throw new Error(`[agent] Session for mode "${mode}" not yet created`);
  const model = getSharedModelRegistry().find(provider, modelId);
  if (!model) throw new Error(`[agent] Unknown model: ${provider}/${modelId}`);
  await session.setModel(model);
  writeModeModel(mode, { provider, modelId });
  console.log(`[agent] Mode "${mode}" model → ${provider}/${modelId}`);
}

/**
 * Fire a prompt on a specific mode's session without switching the global current mode.
 * Used for background tasks (lint pass, etc.) that should run on a specific persona.
 */
export async function promptSession(mode: Mode, text: string): Promise<void> {
  const session = await getOrCreateSession(mode);
  await session.prompt(text, { streamingBehavior: "followUp" });
}

// ── Knowledge synthesis ───────────────────────────────────────────────────────
// A dedicated lightweight session (no tools, no persona) that uses the same
// model + auth as the chat session so it works with any configured provider.

let knowledgeSession: AgentSession | null = null;
let knowledgeResolve: ((text: string) => void) | null = null;
let knowledgeChunks: string[] = [];

async function getOrCreateKnowledgeSession(): Promise<AgentSession> {
  if (knowledgeSession) return knowledgeSession;

  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd: VAULT_ROOT,
    agentDir,
    authStorage: getSharedAuthStorage(),
    modelRegistry: getSharedModelRegistry(),
    resourceLoaderOptions: {
      systemPromptOverride: () =>
        "You are a personal knowledge assistant. Answer questions using ONLY the provided wiki excerpts. Be concise and direct. Cite sources inline using [[Page Title]] wikilink format. If the excerpts don't contain enough information to answer fully, say so.",
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      extensionsOverride: (base) => ({ ...base, extensions: [] }),
    },
  });

  const dir = path.join(SESSIONS_DIR, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  const sessionManager = SessionManager.create(dir);
  const model = resolveModel(CHAT_SESSION_MODE);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    tools: [],
    ...(model ? { model } : {}),
  });

  session.subscribe((event) => {
    if (event.type === "message_update") {
      const sub = (event as any).assistantMessageEvent;
      if (sub?.type === "text_delta" && typeof sub.delta === "string") {
        knowledgeChunks.push(sub.delta);
      }
    } else if (event.type === "agent_end") {
      const text = knowledgeChunks.join("").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      knowledgeChunks = [];
      knowledgeResolve?.(text);
      knowledgeResolve = null;
    }
  });

  knowledgeSession = session;
  return session;
}

/**
 * Run a one-shot knowledge synthesis using the chat model + auth.
 * context = full wiki page content, question = user's question.
 */
export async function synthesiseKnowledge(context: string, question: string): Promise<string> {
  const session = await getOrCreateKnowledgeSession();
  return new Promise((resolve, reject) => {
    knowledgeChunks = [];
    knowledgeResolve = resolve;
    const userPrompt = `Knowledge base:\n${context}\n\nQuestion: ${question}`;
    session.prompt(userPrompt, { streamingBehavior: "followUp" }).catch(reject);
  });
}
