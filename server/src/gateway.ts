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
} from "./agent.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { MODES, MODE_META, type Mode } from "./routes.js";
import { queryKnowledge } from "./knowledge/query.js";
import { getLatestCalDigest } from "./cron.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, type CalEventData } from "./calendar.js";

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

type ClientMessage =
  | { type: "message";     text?: string; project?: string; persona?: "mentor" | "shapeshifter" }
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
function makeCanvasStripper(onCanvas: (json: string) => void): (chunk: string) => string {
  let buf = '';
  let inside = false;

  return function process(chunk: string): string {
    if (!inside) {
      const combined = buf + chunk;
      const start = combined.indexOf('<canvas>');
      if (start === -1) {
        buf = '';
        return combined;
      }
      // Found start — capture text before the tag and enter canvas mode
      const visible = combined.slice(0, start);
      buf = combined.slice(start);
      inside = true;
      return visible;
    }
    buf += chunk;
    const end = buf.indexOf('</canvas>');
    if (end !== -1) {
      const inner = buf.slice('<canvas>'.length, end);
      const tail = buf.slice(end + '</canvas>'.length);
      buf = '';
      inside = false;
      onCanvas(inner.trim());
      return tail;
    }
    return ''; // still inside canvas block, don't emit
  };
}

function makeCalStripper(onCal: (tag: string, json: string) => void): (chunk: string) => string {
  let buf = '';
  let insideTag: string | null = null;
  // Longest partial open tag without closing `>`: '<cal_delete' = 11 chars
  const PARTIAL_HOLD = 11;

  function flush(): string {
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

  return function process(chunk: string): string {
    buf += chunk;
    return flush();
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

/** Map Pi SDK events to WebSocket protocol messages. */
function handleAgentEvent(
  ws: WebSocket,
  event: AgentSessionEvent,
  stripThink: (s: string) => string,
  stripCanvas: (s: string) => string,
  stripCal: (s: string) => string,
): void {
  switch (event.type) {
    case "agent_start":
      send(ws, { type: "agent_start" });
      break;

    case "message_update": {
      const sub = (event as any).assistantMessageEvent;
      if (sub?.type === "thinking_start") {
        send(ws, { type: "agent_thinking" });
      } else if (sub?.type === "thinking_delta" || sub?.type === "reasoning_delta") {
        // Drop reasoning/thinking deltas — don't forward to client
      } else if (sub?.type === "text_delta" && typeof sub.delta === "string") {
        const thinkStripped = stripThink(sub.delta);
        const visible = stripCal(stripCanvas(thinkStripped));
        if (visible) send(ws, { type: "message_update", text: visible });
      }
      break;
    }

    case "agent_end":
      send(ws, { type: "agent_end" });
      // Note: we intentionally do NOT reset isFirstTurn here.
      // Auto-routing should only fire on the first message of a connection
      // (or after an explicit manual mode switch / new conversation).
      // Re-routing on every turn boundary would yank users between personas
      // mid-conversation and lose continuity.
      break;

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
    if (!msg.text?.trim()) {
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

    let promptText = msg.text;
    try {
      // followUp queues behind any in-progress response rather than throwing
      const currentMode = getCurrentMode();
      // Allow client to override persona per-message (e.g. Shapeshifter summoned into Mentor tab)
      const effectivePersona = msg.persona ?? currentMode;

      // Prepend persona tag so the shared chat session knows which flavour to use
      if (CHAT_MODES.has(currentMode as any)) {
        promptText = `[${effectivePersona}]\n${promptText}`;
      }

      if (CHAT_MODES.has(currentMode as any)) {
        try {
          const { answer, sources } = await queryKnowledge(msg.text, 4);
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
            promptText = `[${effectivePersona}]\n<context>\n${context}\n</context>\n\n${msg.text}`;
          } else {
            console.log(`[gateway] No context found for: "${msg.text.slice(0, 60)}"`);
          }
        } catch (err) {
          console.warn(`[gateway] Wiki context lookup failed: ${err}`);
        }
      }
      await getSession().prompt(promptText, { streamingBehavior: "followUp" });
    } catch (err) {
      // If primary model is unreachable and fallback is configured, activate and retry once
      if (isConnectionError(err) && !isFallbackActive()) {
        const activated = await activateFallback();
        if (activated) {
          broadcast(wss, {
            type: "model_fallback",
            message: "Local model offline — switched to cloud fallback",
          });
          try {
            await getSession().prompt(promptText, { streamingBehavior: "followUp" });
            return;
          } catch (retryErr) {
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

export function createGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

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
    send(ws, {
      type: "hello",
      mode: trackedMode,
      modes: Object.values(MODE_META),
    });

    console.log(`[gateway] Client connected (mode: ${trackedMode}, clients: ${wss.clients.size})`);

    // Per-connection project slug (updated whenever client sends a message with project field)
    let connectionProjectSlug = 'inbox';

    // Register this connection's listener in the current mode's fan-out set
    const stripThink = makeThinkStripper();
    const stripCanvas = makeCanvasStripper((json) => {
      processCanvas(json, connectionProjectSlug, wss).catch((err) =>
        console.warn('[gateway] canvas processing error:', err)
      );
    });
    const stripCal = makeCalStripper((tag, json) => {
      processCalAction(tag, json, wss).catch((err) =>
        console.warn('[gateway] cal processing error:', err)
      );
    });
    const listener = (event: AgentSessionEvent) => handleAgentEvent(ws, event, stripThink, stripCanvas, stripCal);
    addModeListener(trackedMode, listener);

    // Heartbeat — detects dead mobile connections
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, HEARTBEAT_MS);
    ws.on("pong", () => { /* keep-alive confirmed */ });

    const onModeSwitch = async (mode: Mode): Promise<void> => {
      await switchMode(mode);
      removeModeListener(trackedMode, listener);
      trackedMode = mode;
      addModeListener(trackedMode, listener);
      broadcast(wss, { type: "mode_changed", mode });
    };

    const onProject = (slug: string) => { connectionProjectSlug = slug; };

    ws.on("message", (data) => {
      handleClientMessage(ws, wss, data.toString(), onModeSwitch, onProject).catch((err) => {
        console.error("[gateway] Unhandled error:", err);
      });
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      removeModeListener(trackedMode, listener);
      console.log(`[gateway] Client disconnected (clients: ${wss.clients.size})`);
      // Abort any queued/in-progress session work when the last client leaves.
      // Prevents stale prompts from backing up the queue for the next connection.
      if (wss.clients.size === 0) {
        setTimeout(() => {
          if (wss.clients.size === 0) {
            getSession()?.abort().catch(() => {});
          }
        }, 5000);
      }
    };

    ws.on("close", cleanup);
    ws.on("error", (err) => { console.error("[gateway] WS error:", err); cleanup(); });
  });

  return wss;
}
