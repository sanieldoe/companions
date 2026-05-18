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
import { resolveModelForMode, resolveDefaultModel, resolveFallbackModel, resolveVisionModel } from "./models.js";
import type { ImageContent } from "@mariozechner/pi-ai";

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
// persona flavour is injected per-message via a [mentor]/[shapeshifter] prefix.
export const CHAT_MODES = new Set<Mode>(["mentor", "shapeshifter"]);
const CHAT_SESSION_MODE: Mode = "mentor"; // canonical key for the shared chat session

// Per-mode session cache
const sessions = new Map<Mode, AgentSession>();

// Per-conversation chat session cache (convId → session)
const chatSessions = new Map<string, AgentSession>();

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

  if (chatSessions.size === 0) return false;

  try {
    for (const session of chatSessions.values()) {
      await session.setModel(fallbackModel);
    }
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

function sessionDir(mode: Mode, convId?: string): string {
  const dir = convId
    ? path.join(SESSIONS_DIR, mode, convId)
    : path.join(SESSIONS_DIR, mode);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read the body of a persona's PERSONA.md with frontmatter stripped. */
function readPersonaBody(m: Mode): string {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(PERSONAS_BASE, m, "PERSONA.md"), "utf8");
  } catch {
    throw new Error(`Missing persona file for mode "${m}". Expected: ${path.join(PERSONAS_BASE, m, "PERSONA.md")}`);
  }
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return fmMatch ? fmMatch[1].trim() : raw.trim();
}

/** Auto-discover all skills and build a directory block for the system prompt. */
function buildSkillsDirectoryBlock(): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch {
    return "";
  }

  const lines: string[] = [];
  for (const name of entries) {
    const skillPath = path.join(SKILLS_BASE, name, "SKILL.md");
    let description = "";
    try {
      const raw = fs.readFileSync(skillPath, "utf8");
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
      }
    } catch {
      continue; // skip skills with no SKILL.md
    }
    lines.push(`- **${name}** — ${description}\n  File: ${skillPath}`);
  }

  if (lines.length === 0) return "";

  return `---

## Available Skills

Load a skill using the \`read\` tool when the task requires it. Only load skills you actually need.

${lines.join("\n")}`;
}

function loadSkillBody(mode: Mode): string {
  const skillsDirectory = buildSkillsDirectoryBlock();

  // Chat session: combine both personas in one system prompt.
  // The active persona is signalled per-message with a [mentor] or [shapeshifter] prefix.
  // /no_think disables Qwen3's chain-of-thought so it doesn't exhaust the token
  // budget before emitting tool calls.
  if (mode === CHAT_SESSION_MODE) {
    const mentorBlock = readPersonaBody("mentor");
    const shapeshifterBlock = readPersonaBody("shapeshifter");

    const parts = [
      `/no_think`,
      `You are a dual-mode AI companion. The mode for each response is indicated at the very start of the user message:
- \`[mentor]\` → respond as Mentor
- \`[shapeshifter]\` → respond as Shapeshifter

Never mention the prefix tags. Simply read the tag, adopt that persona for your response, and strip the tag from your awareness of the message.

**Conversation memory:** Prior messages in this conversation are already loaded in your context. When the user asks what you discussed, recall directly from the conversation history above — do not search for files to answer memory questions.`,
      `---`,
      mentorBlock,
      `---`,
      shapeshifterBlock,
    ];

    if (skillsDirectory) parts.push(skillsDirectory);

    return parts.join("\n\n");
  }

  const personaBody = readPersonaBody(mode);
  const parts = [`/no_think`, personaBody];
  if (skillsDirectory) parts.push(skillsDirectory);
  return parts.join("\n\n");
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

async function buildChatSession(convId: string, slug: string): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const skillBody = loadSkillBody(CHAT_SESSION_MODE);

  const services = await createAgentSessionServices({
    cwd: VAULT_ROOT,
    agentDir,
    authStorage: getSharedAuthStorage(),
    modelRegistry: getSharedModelRegistry(),
    resourceLoaderOptions: {
      systemPromptOverride: () => skillBody,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      extensionsOverride: (base) => ({ ...base, extensions: [] }),
    },
  });

  const convSessionDir = path.join(VAULT_ROOT, "projects", slug, ".sessions", convId);
  fs.mkdirSync(convSessionDir, { recursive: true });
  const sessionManager = SessionManager.continueRecent(VAULT_ROOT, convSessionDir);
  const model = resolveModel(CHAT_SESSION_MODE);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    ...(model ? { model } : {}),
  });

  // Fan out to BOTH mentor and shapeshifter listener sets so the active
  // listener receives events regardless of which persona is selected.
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const e = event as any;
      console.log(`[agent.tool] START  tool=${e.toolName}  args=${JSON.stringify(e.args ?? {})}`);
    } else if (event.type === "tool_execution_end") {
      const e = event as any;
      console.log(`[agent.tool] END    tool=${e.toolName}  isError=${e.isError}  result=${JSON.stringify(e.result ?? "").slice(0, 200)}`);
    }

    const sets = [modeListeners.get("mentor"), modeListeners.get("shapeshifter")];
    for (const set of sets) {
      if (set) for (const listener of set) listener(event);
    }
  });

  return session;
}

/**
 * If the session dir is empty but a vault convo exists, write a JSONL session
 * file in the Pi SDK format so the session picks up the full conversation history.
 */
function bootstrapSessionFromVault(convId: string, slug: string): void {
  const sessDir = path.join(VAULT_ROOT, 'projects', slug, '.sessions', convId);

  // If there are already JSONL files, the SDK has its own history — skip
  if (fs.existsSync(sessDir)) {
    const existing = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    if (existing.length > 0) return;
  }

  const convoPath = path.join(VAULT_ROOT, 'projects', slug, 'convos', `${convId}.json`);
  if (!fs.existsSync(convoPath)) return;

  let messages: Array<{ role: string; text: string; timestamp?: number }>;
  try {
    messages = JSON.parse(fs.readFileSync(convoPath, 'utf8'));
  } catch { return; }

  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 0) return;

  fs.mkdirSync(sessDir, { recursive: true });

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const entries: object[] = [
    { type: 'session', version: 3, id: sessionId, timestamp: now, cwd: VAULT_ROOT },
  ];

  let prevId: string | null = null;
  for (const msg of turns) {
    const id = crypto.randomUUID().slice(0, 8);
    const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : now;
    const message: Record<string, unknown> = { role: msg.role, content: [{ type: 'text', text: msg.text }] };
    if (msg.role === 'assistant') {
      // SDK's _checkCompaction reads usage.totalTokens before each prompt() — provide zeros to avoid crash
      message.stopReason = 'end_turn';
      message.usage = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    entries.push({ type: 'message', id, parentId: prevId, timestamp: ts, message });
    prevId = id;
  }

  const filename = `${now.replace(/[:.]/g, '-')}_${sessionId}.jsonl`;
  fs.writeFileSync(path.join(sessDir, filename), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`[agent] Bootstrapped session from vault: ${turns.length} turns → ${filename}`);
}

export async function getChatSession(convId: string, slug: string): Promise<AgentSession> {
  const key = `${slug}:${convId}`;
  const existing = chatSessions.get(key);
  if (existing) return existing;
  bootstrapSessionFromVault(convId, slug);
  const session = await buildChatSession(convId, slug);
  chatSessions.set(key, session);
  return session;
}

async function getOrCreateSession(mode: Mode): Promise<AgentSession> {
  const existing = sessions.get(mode);
  if (existing) return existing;
  const session = await buildSession(mode);
  sessions.set(mode, session);
  return session;
}

/**
 * Drop the cached session for a mode so the next request rebuilds it
 * with the current PERSONA.md content. For chat modes (mentor/shapeshifter)
 * both share one session so we bust the canonical key.
 */
export function resetSession(mode: Mode): void {
  if (CHAT_MODES.has(mode)) {
    chatSessions.clear();
    console.log(`[agent] All chat sessions reset — will rebuild on next use`);
  } else {
    if (sessions.has(mode)) {
      sessions.delete(mode);
      console.log(`[agent] Session reset for mode "${mode}" — will rebuild on next use`);
    }
  }
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

// ── Vision session (Gemma 4 via Ollama) ──────────────────────────────────────

let visionSession: AgentSession | null = null;
const visionListeners = new Set<(event: AgentSessionEvent) => void>();

const VISION_SYSTEM_PROMPT = `/no_think

You are a visual and document analyst built into a personal AI companion.
Analyse whatever content is provided — images, files, or both — and respond clearly and concisely.
If a user message accompanies the content, address it directly.
Be specific: describe what you actually see or read, not what you expect to see.`;

async function buildVisionSession(): Promise<AgentSession> {
  const visionModel = resolveVisionModel();
  if (!visionModel) throw new Error("[agent] VISION_MODEL is not configured");

  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd: VAULT_ROOT,
    agentDir,
    authStorage: getSharedAuthStorage(),
    modelRegistry: getSharedModelRegistry(),
    resourceLoaderOptions: {
      systemPromptOverride: () => VISION_SYSTEM_PROMPT,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      extensionsOverride: (base: any) => ({ ...base, extensions: [] }),
    },
  });

  const sessionDir = path.join(SESSIONS_DIR, "vision");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(sessionDir);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    tools: ["read"],
    model: visionModel,
  });

  session.subscribe((event) => {
    for (const listener of visionListeners) listener(event);
  });

  console.log(`[agent] Vision session ready (${visionModel.name})`);
  return session;
}

export async function getVisionSession(): Promise<AgentSession> {
  if (!visionSession) visionSession = await buildVisionSession();
  return visionSession;
}

export function addVisionListener(listener: (event: AgentSessionEvent) => void): void {
  visionListeners.add(listener);
}

export function removeVisionListener(listener: (event: AgentSessionEvent) => void): void {
  visionListeners.delete(listener);
}

/** Initialise the agent. Call once at startup. */
export async function initAgent(mode: Mode = "mentor"): Promise<void> {
  getSharedAuthStorage();
  fs.mkdirSync(path.join(COMPANION_DIR, "projects"), { recursive: true });
  currentMode = mode;
  if (!CHAT_MODES.has(mode)) {
    currentSession = await getOrCreateSession(mode);
  }
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
  // Chat modes are lazy per-conversation — no shared session to swap to
  if (CHAT_MODES.has(mode)) {
    currentSession = null;
    return;
  }
  currentSession = await getOrCreateSession(mode);
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

// ── Compile LLM — direct GitHub Copilot HTTP (bypasses pi-ai session hang) ──

let _copilotToken: { token: string; expires_at: number } | null = null;

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

async function getCopilotToken(): Promise<string | null> {
  const agentDir = getAgentDir();
  const authPath = path.join(agentDir, "auth.json");
  let auth: any;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    return null;
  }

  const copilotAuth = auth?.["github-copilot"];
  if (!copilotAuth) return null;

  // access field is the short-lived Copilot API token — use it directly if not expired
  if (copilotAuth.access && copilotAuth.expires && copilotAuth.expires > Date.now() + 60_000) {
    return copilotAuth.access;
  }

  // Expired — exchange the long-lived GitHub OAuth token (refresh) for a new Copilot token
  const refreshToken = copilotAuth.refresh;
  if (!refreshToken) return null;

  try {
    const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${refreshToken}`,
        ...COPILOT_HEADERS,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.error(`[compile] Copilot token exchange failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json() as { token: string; expires_at: number };
    _copilotToken = { token: data.token, expires_at: data.expires_at };
    return data.token;
  } catch (err) {
    console.error("[compile] Copilot token exchange error:", err);
    return null;
  }
}

/**
 * Run a one-shot LLM compile. Uses GitHub Copilot directly if available,
 * falls back to the model configured in DEFAULT_MODEL env var.
 */
export async function compileLLM(systemPrompt: string, userContent: string): Promise<string> {
  console.log(`[compile] Starting (~${systemPrompt.length + userContent.length} chars)`);

  // Always use DEFAULT_MODEL for compile tasks (local model priority)
  const model = resolveModel(CHAT_SESSION_MODE);
  if (!model) throw new Error("[compile] No model configured");

  if (model.provider === "anthropic" || model.api === "anthropic-messages") {
    const modelHeaders: Record<string, string> = (model as any).headers ?? {};
    const baseUrl = (model as any).baseUrl ?? "https://api.anthropic.com";
    const authHeaders: Record<string, string> = {};
    if (model.provider === "anthropic") {
      const key = process.env.DEFAULT_MODEL_KEY ?? "";
      if (!key) throw new Error("[compile] No API key for Anthropic");
      authHeaders["x-api-key"] = key;
    }
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...authHeaders, ...modelHeaders },
      body: JSON.stringify({ model: model.id, max_tokens: 8192, system: systemPrompt, messages: [{ role: "user", content: userContent }] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`[compile] Anthropic API error ${resp.status}`);
    const data = await resp.json() as { content?: { text?: string }[] };
    const raw = data?.content?.[0]?.text?.trim() ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return jsonMatch ? jsonMatch[0] : raw;
  }

  if (model.api === "openai-completions" && (model as any).baseUrl) {
    const key = (model as any).headers?.Authorization?.replace("Bearer ", "") ?? process.env.DEFAULT_MODEL_KEY ?? "";
    const resp = await fetch(`${(model as any).baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: model.id, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], max_tokens: 8192, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`[compile] API error ${resp.status}`);
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    return data?.choices?.[0]?.message?.content?.trim() ?? "";
  }

  throw new Error(`[compile] Unsupported model provider: ${model.provider}`);
}
