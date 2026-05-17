/**
 * gateway.ts
 *
 * WebSocket gateway — bridges Android client with the Pi SDK agent.
 *
 * Client → Server:
 *   { type: "message",     text: "..." }
 *   { type: "switch_mode", mode: "mentor" }
 *   { type: "abort" }
 *
 * Server → Client:
 *   { type: "hello",          mode: "mentor", modes: [...] }
 *   { type: "agent_start" }
 *   { type: "agent_thinking" }                  ← model is reasoning, not yet talking
 *   { type: "message_update", text: "..." }      ← streaming token
 *   { type: "agent_end" }
 *   { type: "mode_changed",   mode: "mentor" }   ← broadcast to all clients
 *   { type: "error",          code: "...", message: "..." }
 *
 * Listener model: each connection registers a listener in the per-mode fan-out
 * set (agent.ts). On mode switch the listener is moved to the new mode's set.
 * On disconnect it is removed. No global "current listener" exists.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyToken } from "./auth.js";

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");
import {
  getSession,
  switchMode,
  getCurrentMode,
  addModeListener,
  removeModeListener,
  CHAT_MODES,
  isFallbackActive,
  activateFallback,
  getVisionSession,
  addVisionListener,
  removeVisionListener,
} from "./agent.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { MODES, getModeInfos, type Mode } from "./routes.js";
import { queryKnowledge } from "./knowledge/query.js";
import { getLatestCalDigest } from "./cron.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, type CalEventData } from "./calendar.js";

const HEARTBEAT_MS = 60_000;

// Tracks whether the agent is actively generating — used to prevent
// heartbeat kills and premature aborts while the user is backgrounded.
let agentRunning = false;

// Server-side response accumulation — saves completed responses even when client is disconnected
let responseAccumulator = '';
let trackedConvId: string | null = null;
let trackedConvSlug = 'general';
let trackedUserMessage = '';
let trackedPersona = 'mentor';

// Shared send function — all listeners route through this so the target ws can be
// swapped on reconnect without re-registering the listener.
const sharedSend: { fn: (payload: Record<string, unknown>) => void } = { fn: () => {} };
// Buffer accumulated while the client is backgrounded (agentRunning but no ws)
let replayBuffer: Record<string, unknown>[] | null = null;
// Listener kept alive across a client disconnect so the stream isn't interrupted
let orphanedListener: ((event: AgentSessionEvent) => void) | null = null;
let orphanedMode: string | null = null;
// Tracks the currently-bound ws so a late `close` event from a stale socket
// (after a newer one has already taken over) doesn't clobber sharedSend.
let activeWs: WebSocket | null = null;

const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_PREFIXES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]);

function isImageFile(fileName?: string, fileMime?: string): boolean {
  if (fileMime && IMAGE_MIME_PREFIXES.some(p => fileMime.startsWith(p))) return true;
  if (fileName) {
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }
  return false;
}

type ClientMessage =
  | { type: "message";     text?: string; project?: string; persona?: "mentor" | "shapeshifter"; fileName?: string; fileContent?: string; fileMime?: string; conversationId?: string }
  | { type: "switch_mode"; mode?: string }
  | { type: "abort" };

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function broadcastAll(wss: WebSocketServer, payload: Record<string, unknown>): void {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcast(wss: WebSocketServer, payload: Record<string, unknown>): void {
  broadcastAll(wss, payload);
}

/**
 * Per-connection stateful stripper for <think>...</think> blocks.
 * Tags may span multiple chunks, so inside-state must persist across calls.
 */
function makeThinkStripper() {
  let inside = false;
  return function strip(chunk: string): string {
    let out = '';
    let i = 0;
    while (i < chunk.length) {
      if (!inside) {
        const open = chunk.indexOf('<think>', i);
        if (open === -1) { out += chunk.slice(i); break; }
        out += chunk.slice(i, open);
        inside = true;
        i = open + 7;
      } else {
        const close = chunk.indexOf('</think>', i);
        if (close === -1) { i = chunk.length; break; } // still inside, discard rest
        inside = false;
        i = close + 8;
      }
    }
    return out;
  };
}

/**
 * Per-connection canvas stripper.
 * Buffers text between <canvas> and </canvas> tags and returns only visible text.
 * Calls onCanvas with the extracted JSON once the closing tag is found.
 */
function makeCanvasStripper(onCanvas: (json: string) => void): { process: (chunk: string) => string; flush: () => string } {
  let buf = '';
  let inside = false;
  // Hold back enough chars so a "```json\n" fence arriving just before <canvas>
  // is still in the buffer when we detect the tag and can be stripped.
  // "```json\n" = 8 chars; use 12 for safety.
  const HOLD = 12;

  return {
    process(chunk: string): string {
      if (!inside) {
        buf += chunk;
        const start = buf.indexOf('<canvas>');
        if (start === -1) {
          // No canvas tag yet — emit safely but keep a tail as lookahead
          const safe = buf.length - HOLD;
          if (safe <= 0) return '';
          const out = buf.slice(0, safe);
          buf = buf.slice(safe);
          return out;
        }
        // Strip any code fence immediately before <canvas>
        const visible = buf.slice(0, start).replace(/`{3}[a-z]*\n?$/, '');
        buf = buf.slice(start);
        inside = true;
        return visible;
      }
      buf += chunk;
      const end = buf.indexOf('</canvas>');
      if (end !== -1) {
        const inner = buf.slice('<canvas>'.length, end);
        // Strip any code fence immediately after </canvas>
        const tail = buf.slice(end + '</canvas>'.length).replace(/^\n?`{3}\n?/, '');
        buf = '';
        inside = false;
        onCanvas(inner.trim());
        return tail;
      }
      return '';
    },
    flush(): string {
      const out = buf;
      buf = '';
      inside = false;
      return out;
    },
  };
}

function makeCalStripper(onCal: (tag: string, json: string) => void): { process: (chunk: string) => string; flush: () => string } {
  let buf = '';
  let insideTag: string | null = null;
  // Longest partial open tag without closing `>`: '<cal_delete' = 11 chars
  const PARTIAL_HOLD = 11;

  function drain(): string {
    let out = '';
    while (true) {
      if (!insideTag) {
        const match = buf.match(/<(cal_(?:create|update|delete))>/);
        if (!match || match.index === undefined) {
          // No complete open tag — emit everything except a partial-tag tail
          const safe = buf.length - PARTIAL_HOLD;
          if (safe <= 0) return out;
          out += buf.slice(0, safe);
          buf = buf.slice(safe);
          return out;
        }
        // Emit text before the tag, then consume the open tag
        out += buf.slice(0, match.index);
        buf = buf.slice(match.index + `<${match[1]}>`.length);
        insideTag = match[1];
      }

      // Inside tag — wait for close
      const closeTag = `</${insideTag}>`;
      const end = buf.indexOf(closeTag);
      if (end === -1) return out; // still accumulating
      const inner = buf.slice(0, end);
      buf = buf.slice(end + closeTag.length);
      const tag = insideTag;
      insideTag = null;
      onCal(tag, inner.trim());
      // Loop to handle content after the close tag
    }
  }

  return {
    process(chunk: string): string {
      buf += chunk;
      return drain();
    },
    flush(): string {
      // Release whatever remains in the hold buffer at end-of-turn
      const out = buf;
      buf = '';
      insideTag = null;
      return out;
    },
  };
}

async function processCanvas(inner: string, slug: string, wss: WebSocketServer): Promise<void> {
  let parsed: { blocks?: unknown[] };
  try {
    parsed = JSON.parse(inner);
  } catch {
    console.warn('[gateway] canvas: malformed JSON, skipping');
    return;
  }

  const canvas = {
    version: 1,
    blocks: parsed.blocks ?? [],
    updatedAt: new Date().toISOString(),
  };

  const canvasPath = path.join(VAULT_ROOT, 'projects', slug, 'canvas.json');
  try {
    await fs.promises.mkdir(path.dirname(canvasPath), { recursive: true });
    await fs.promises.writeFile(canvasPath, JSON.stringify(canvas, null, 2));
    console.log(`[gateway] canvas saved: projects/${slug}/canvas.json`);
  } catch (err) {
    console.warn('[gateway] canvas: failed to write file:', err);
    return;
  }

  broadcastAll(wss, { type: 'canvas_update', slug, canvas });
}

async function processCalAction(tag: string, json: string, wss: WebSocketServer): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json);
  } catch {
    console.warn('[gateway] cal: malformed JSON, skipping');
    return;
  }

  let result: { ok: boolean; eventId?: string; link?: string; error?: string };
  if (tag === 'cal_create') {
    result = await createCalendarEvent(data as unknown as CalEventData);
  } else if (tag === 'cal_update') {
    const { title, date, ...updates } = data as { title: string; date: string } & Partial<CalEventData>;
    result = await updateCalendarEvent(title, date, updates);
  } else if (tag === 'cal_delete') {
    result = await deleteCalendarEvent(data.title as string, data.date as string);
  } else {
    return;
  }

  console.log(`[gateway] cal ${tag}:`, result);
  broadcastAll(wss, { type: 'calendar_result', action: tag, ...result });
}

async function saveResponseToConvo(
  slug: string,
  convId: string,
  userText: string,
  assistantText: string,
  persona: string,
): Promise<void> {
  const dir = path.join(VAULT_ROOT, 'projects', slug, 'convos');
  const filePath = path.join(dir, `${convId}.json`);

  let messages: Array<Record<string, unknown>> = [];
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    messages = JSON.parse(raw);
  } catch { /* new conversation — start empty */ }

  // If the last message is already an assistant response, the client already saved it — skip.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant') {
    console.log(`[gateway] Response already saved by client for ${convId}, skipping`);
    return;
  }

  // Add user message if missing (e.g. _syncToServer failed before disconnect)
  const hasUserMsg = messages.some(m => m.role === 'user' && m.text === userText);
  if (!hasUserMsg && userText.trim()) {
    messages.push({ id: `user-${Date.now() - 1}`, role: 'user', text: userText, timestamp: Date.now() - 1 });
  }

  messages.push({
    id: `assistant-${Date.now()}`,
    role: 'assistant',
    text: assistantText,
    timestamp: Date.now(),
    persona,
  });

  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(messages, null, 2));
  console.log(`[gateway] Server-saved response to ${slug}/${convId} (${assistantText.length} chars)`);
}

/** Map Pi SDK events to WebSocket protocol messages. */
function handleAgentEvent(
  event: AgentSessionEvent,
  stripThink: (s: string) => string,
  canvas: { process: (s: string) => string; flush: () => string },
  cal: { process: (s: string) => string; flush: () => string },
  getPersona: () => string,
): void {
  switch (event.type) {
    case "agent_start":
      agentRunning = true;
      sharedSend.fn({ type: "agent_start" });
      break;

    case "message_update": {
      const sub = (event as any).assistantMessageEvent;
      if (sub?.type === "thinking_start") {
        sharedSend.fn({ type: "agent_thinking" });
      } else if (sub?.type === "thinking_delta" || sub?.type === "reasoning_delta") {
        // Drop reasoning/thinking deltas — don't forward to client
      } else if (sub?.type === "text_delta" && typeof sub.delta === "string") {
        const thinkStripped = stripThink(sub.delta);
        const visible = cal.process(canvas.process(thinkStripped));
        if (visible) {
          responseAccumulator += visible;
          sharedSend.fn({ type: "message_update", text: visible });
        }
      }
      break;
    }

    case "agent_end": {
      agentRunning = false;
      // Flush lookahead buffers — canvas first (inner), then cal (outer)
      const canvasTail = canvas.flush();
      const calTail = cal.flush();
      const tail = calTail + canvasTail;
      if (tail) {
        responseAccumulator += tail;
        sharedSend.fn({ type: "message_update", text: tail });
      }
      // Save to disk regardless of client connectivity so loadConversations picks it up on reconnect
      if (trackedConvId && responseAccumulator.trim()) {
        saveResponseToConvo(trackedConvSlug, trackedConvId, trackedUserMessage, responseAccumulator.trim(), getPersona()).catch(
          (err) => console.warn('[gateway] Server-side save failed:', err)
        );
      }
      sharedSend.fn({ type: "agent_end", persona: getPersona() });
      break;
    }

    default:
      break;
  }
}

function authenticate(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";
  if (!token) return false;
  try {
    verifyToken(token);
    return true;
  } catch {
    return false;
  }
}

async function handleClientMessage(
  ws: WebSocket,
  wss: WebSocketServer,
  raw: string,
  onModeSwitch: (mode: Mode) => Promise<void>,
  onProject: (slug: string) => void,
  setPersona: (p: string) => void = () => {},
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    send(ws, { type: "error", code: "bad_input", message: "Invalid JSON" });
    return;
  }

  if (msg.type === "abort") {
    try {
      await getSession().abort();
    } catch (err) {
      send(ws, { type: "error", code: "abort_failed", message: String(err) });
    }
    return;
  }

  if (msg.type === "message") {
    if (!msg.text?.trim() && !msg.fileContent) {
      send(ws, { type: "error", code: "bad_input", message: "Empty message" });
      return;
    }

    // Update the connection's project slug if provided
    if (msg.project) {
      onProject(msg.project);
    }

    const isConnectionError = (e: unknown): boolean => {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      return msg.includes("econnrefused") || msg.includes("fetch failed") ||
        msg.includes("etimedout") || msg.includes("enotfound") ||
        msg.includes("network") || msg.includes("connect");
    };

    let promptText = msg.text ?? "";
    try {
      // followUp queues behind any in-progress response rather than throwing
      const currentMode = getCurrentMode();
      // Allow client to override persona per-message (e.g. Shapeshifter summoned into Mentor tab)
      const effectivePersona = msg.persona ?? currentMode;
      // Track context for server-side response save on agent_end
      if (msg.conversationId) trackedConvId = msg.conversationId;
      trackedConvSlug = msg.project ?? 'general';
      trackedUserMessage = msg.text ?? '';
      trackedPersona = effectivePersona;
      responseAccumulator = '';

      // ── Vision path: direct Ollama streaming call with think:false ───────────
      // Bypasses Pi SDK session to avoid gemma4's extended thinking phase,
      // which blocks the stream until reasoning finishes (can take minutes).
      if (msg.fileContent && isImageFile(msg.fileName, msg.fileMime)) {
        const mimeType = msg.fileMime ?? "image/jpeg";
        const visionPrompt = promptText.trim() || "Describe this image.";
        console.log(`[gateway] Routing image to vision (direct) (${msg.fileName})`);
        send(ws, { type: "agent_start" });

        const thinkingInterval = setInterval(() => {
          send(ws, { type: "agent_thinking" });
        }, 5_000);

        try {
          const visionEnv = process.env.VISION_MODEL ?? "";
          // Parse: openai-compat:http://host:port/v1:model-name (model may contain colons)
          const visionMatch = visionEnv.match(/^[^:]+:(https?:\/\/.*?\/[^:]*):(.+)$/);
          if (!visionMatch) throw new Error(`Cannot parse VISION_MODEL: ${visionEnv}`);
          const baseUrl = visionMatch[1]; // e.g. http://localhost:11434/v1
          const modelName = visionMatch[2]; // e.g. gemma4:e4b
          const apiKey = process.env.VISION_MODEL_KEY ?? "ollama";

          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: modelName,
              stream: true,
              think: false,
              messages: [{
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: `data:${mimeType};base64,${msg.fileContent}` } },
                  { type: "text", text: visionPrompt },
                ],
              }],
            }),
          });

          if (!response.ok || !response.body) {
            throw new Error(`Vision API error: ${response.status}`);
          }

          let fullText = "";
          const decoder = new TextDecoder();
          const reader = response.body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
              try {
                const parsed = JSON.parse(trimmed.slice(6));
                const delta = parsed.choices?.[0]?.delta?.content ?? "";
                if (delta) {
                  fullText += delta;
                  send(ws, { type: "message_update", text: delta });
                }
              } catch { /* skip malformed SSE lines */ }
            }
          }

          send(ws, { type: "agent_end" });
          console.log(`[gateway] Vision response complete (${fullText.length} chars)`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[gateway] Vision error:", message);
          send(ws, { type: "error", code: "vision_error", message });
          send(ws, { type: "agent_end" });
        } finally {
          clearInterval(thinkingInterval);
        }
        return;
      }

      // ── Text file: inject content as context block ─────────────────────────
      if (msg.fileContent && msg.fileName) {
        const MAX_FILE_CHARS = 40_000;
        const truncated = msg.fileContent.length > MAX_FILE_CHARS
          ? msg.fileContent.slice(0, MAX_FILE_CHARS) + "\n\n[File truncated]"
          : msg.fileContent;
        promptText = `<file name="${msg.fileName}">\n${truncated}\n</file>\n\n${promptText}`;
      }

      // ── Regular chat path: Qwen3 session ───────────────────────────────────
      // Prepend persona tag so the shared chat session knows which flavour to use
      if (CHAT_MODES.has(currentMode as any)) {
        console.log(`[gateway] persona=${effectivePersona} currentMode=${currentMode} msg.persona=${msg.persona}`);
        setPersona(effectivePersona);
        promptText = `[${effectivePersona}]\n${promptText}`;
      }

      if (CHAT_MODES.has(currentMode as any)) {
        try {
          const { answer, sources } = await queryKnowledge(msg.text ?? "", 4);
          const calDigest = getLatestCalDigest();
          const hasWiki = answer && answer !== "No relevant knowledge found.";

          if (hasWiki || calDigest) {
            let context = "";
            if (hasWiki) {
              console.log(`[gateway] Injecting wiki context (${sources.length} sources): ${sources.join(', ')}`);
              context += `Knowledge base:\n${answer}`;
            }
            if (calDigest) {
              if (context) context += "\n\n";
              context += `Calendar (today's upcoming events):\n${calDigest}`;
            }
            promptText = `[${effectivePersona}]\n<context>\n${context}\n</context>\n\n${promptText}`;
          } else {
            console.log(`[gateway] No context found for: "${(msg.text ?? "").slice(0, 60)}"`);
          }
        } catch (err) {
          console.warn(`[gateway] Wiki context lookup failed: ${err}`);
        }
      }
      agentRunning = true; // set early — prevents cleanup() removing listener before agent_start fires
      await getSession().prompt(promptText, { streamingBehavior: "followUp" });
    } catch (err) {
      agentRunning = false; // reset if prompt failed before agent_start
      // If primary model is unreachable and fallback is configured, activate and retry once
      if (isConnectionError(err) && !isFallbackActive()) {
        const activated = await activateFallback();
        if (activated) {
          broadcast(wss, {
            type: "model_fallback",
            message: "Local model offline — switched to cloud fallback",
          });
          try {
            agentRunning = true;
            await getSession().prompt(promptText, { streamingBehavior: "followUp" });
            return;
          } catch (retryErr) {
            agentRunning = false;
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            send(ws, { type: "error", code: "model_unavailable", message: `Fallback also failed: ${retryMsg}` });
            return;
          }
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = message.toLowerCase().includes("api key") || message.toLowerCase().includes("connect")
        ? "model_unavailable"
        : "prompt_error";
      send(ws, { type: "error", code, message });
    }
    return;
  }

  if (msg.type === "switch_mode") {
    const mode = msg.mode;
    if (!mode || !(MODES as readonly string[]).includes(mode)) {
      send(ws, {
        type: "error",
        code: "bad_input",
        message: `Unknown mode: ${mode}. Valid: ${MODES.join(", ")}`,
      });
      return;
    }
    try {
      await onModeSwitch(mode as Mode);
    } catch (err) {
      send(ws, { type: "error", code: "switch_failed", message: String(err) });
    }
    return;
  }

  send(ws, { type: "error", code: "bad_input", message: `Unknown type: ${(msg as any).type}` });
}

let _wss: WebSocketServer | null = null;

/** Broadcast a fresh hello with current mode names to all connected clients. */
export function broadcastModes(): void {
  if (!_wss) return;
  broadcastAll(_wss, {
    type: "hello",
    mode: getCurrentMode(),
    modes: getModeInfos(),
  });
}

export function createGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  _wss = wss;

  server.on("upgrade", (req, socket, head) => {
    if (!authenticate(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    let trackedMode = getCurrentMode();

    // Send hello so client knows current mode immediately on connect/reconnect
    // hasReplay signals that buffered tokens will follow — client must defer loadConversations.
    // NOTE: do NOT require agentRunning here — the agent may have finished while the client
    // was disconnected. The buffer still contains the full response + agent_end we need to replay.
    const hasReplay = replayBuffer !== null && replayBuffer.length > 0;
    send(ws, {
      type: "hello",
      mode: trackedMode,
      modes: getModeInfos(),
      hasReplay,
    });

    console.log(`[gateway] Client connected (mode: ${trackedMode}, clients: ${wss.clients.size})`);

    // Per-connection project slug (updated whenever client sends a message with project field)
    let connectionProjectSlug = 'inbox';

    // Register this connection's listener in the current mode's fan-out set
    const stripThink = makeThinkStripper();
    const canvas = makeCanvasStripper((json) => {
      processCanvas(json, connectionProjectSlug, wss).catch((err) =>
        console.warn('[gateway] canvas processing error:', err)
      );
    });
    const cal = makeCalStripper((tag, json) => {
      processCalAction(tag, json, wss).catch((err) =>
        console.warn('[gateway] cal processing error:', err)
      );
    });
    let currentPersona = 'mentor';

    // ── Reconnect: resume any in-progress stream ──────────────────────────────
    // Remove orphaned listener from previous connection (kept alive during agent run)
    if (orphanedListener && orphanedMode) {
      removeModeListener(orphanedMode as Mode, orphanedListener);
      orphanedListener = null;
      orphanedMode = null;
    }
    // Replay buffered tokens. Don't require agentRunning — agent may have already
    // ended while client was away, and the buffer contains the full response + agent_end
    // we need to deliver before the client calls loadConversations.
    if (replayBuffer !== null && replayBuffer.length > 0) {
      send(ws, { type: 'agent_start' }); // clears client streamingText before replay
      for (const msg of replayBuffer) send(ws, msg);
    }
    replayBuffer = null;
    // Route all agent events to this connection
    sharedSend.fn = (p) => send(ws, p);
    // Track active ws for cleanup race detection
    activeWs = ws;

    const listener = (event: AgentSessionEvent) => handleAgentEvent(event, stripThink, canvas, cal, () => currentPersona);
    addModeListener(trackedMode, listener);
    // Vision listener is registered per-prompt in the vision path, not at connection time.

    // Heartbeat — terminates dead mobile connections that don't respond to pings.
    // If the client doesn't pong within HEARTBEAT_MS, close the socket.
    let isAlive = true;
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        if (agentRunning) {
          // Client backgrounded while agent is responding — keep alive, reset probe.
          isAlive = false;
          if (ws.readyState === WebSocket.OPEN) ws.ping();
          return;
        }
        console.log("[gateway] Heartbeat timeout — closing dead socket");
        ws.terminate();
        return;
      }
      isAlive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, HEARTBEAT_MS);
    ws.on("pong", () => { isAlive = true; });

    const onModeSwitch = async (mode: Mode): Promise<void> => {
      await switchMode(mode);
      removeModeListener(trackedMode, listener);
      trackedMode = mode;
      addModeListener(trackedMode, listener);
      broadcast(wss, { type: "mode_changed", mode });
    };

    const onProject = (slug: string) => { connectionProjectSlug = slug; };

    ws.on("message", (data) => {
      handleClientMessage(ws, wss, data.toString(), onModeSwitch, onProject, (p) => { currentPersona = p; }).catch((err) => {
        console.error("[gateway] Unhandled error:", err);
      });
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      console.log(`[gateway] Client disconnected (clients: ${wss.clients.size})`);
      // If a newer connection has already taken over (activeWs !== this ws), this
      // close event is from a stale socket — don't seed replay buffer or swap sharedSend,
      // doing so would redirect the live agent stream into a dead buffer.
      const isStaleClose = activeWs !== ws;
      if (isStaleClose) {
        console.log('[gateway] Stale close ignored — newer connection already active');
        return;
      }
      if (agentRunning) {
        // Seed replay buffer with text already streamed to the client so the
        // reconnected client receives the full response, not just the second half.
        const snapshot = responseAccumulator;
        replayBuffer = snapshot ? [{ type: 'message_update', text: snapshot }] : [];
        sharedSend.fn = (p) => { replayBuffer?.push(p); };
        orphanedListener = listener;
        orphanedMode = trackedMode;
        activeWs = null;
        console.log('[gateway] Agent running — keeping listener alive for reconnect');
      } else {
        removeModeListener(trackedMode, listener);
        sharedSend.fn = () => {};
        activeWs = null;
      }
      if (wss.clients.size === 0 && !agentRunning) {
        setTimeout(() => {
          if (wss.clients.size === 0 && !agentRunning) {
            getSession()?.abort().catch(() => {});
          }
        }, 30_000);
      }
    };

    ws.on("close", cleanup);
    ws.on("error", (err) => { console.error("[gateway] WS error:", err); cleanup(); });
  });

  return wss;
}
