import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { authVerifyHandler, healthHandler, requireAuth } from "./auth.js";
import { createRouter } from "./routes.js";
import { createGateway } from "./gateway.js";
import { initAgent } from "./agent.js";
import { createWikiRouter } from "./wiki.js";
import { createKnowledgeRouter } from "./knowledge/router.js";
import { createCalendarRouter, calendarOAuthCallback } from "./calendar.js";
import { createProvidersRouter } from "./providers.js";
import { createChatsRouter, migrateToInbox } from "./chats.js";
import { initCron } from "./cron.js";
import { getConfig } from "./config.js";
import type { Mode } from "./routes.js";

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_MODE: Mode = "mentor";

async function main() {
  if (!process.env.COMPANION_VAULT) {
    console.warn("[server] WARNING: COMPANION_VAULT is not set. Knowledge indexing will resolve to the wrong directory. Set COMPANION_VAULT in .env.");
  }

  console.log("[server] Initializing agent...");
  await initAgent(DEFAULT_MODE);
  console.log("[server] Agent ready.");

  const app = express();
  app.use(cors({
    origin: /^https?:\/\/(localhost|100\.\d+\.\d+\.\d+|[\w-]+\.ts\.net)(:\d+)?$/,
  }));
  app.use(express.json({ limit: "16kb" }));

  // Serve web app (built from web/dist) — unauthenticated
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, '../../web/dist');
  app.use('/app', express.static(webDist));
  app.get('/app/*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));

  // /ping is unauthenticated — useful for pm2 health checks and monitoring
  app.get("/ping", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/health", healthHandler);
  app.post("/api/auth/verify", authVerifyHandler);
  app.get("/calendar/callback", calendarOAuthCallback);

  app.use("/api", requireAuth, createRouter());
  app.use("/api", requireAuth, createWikiRouter());
  app.use("/api", requireAuth, createKnowledgeRouter());
  app.use("/api", requireAuth, createCalendarRouter());
  app.use("/api", requireAuth, createProvidersRouter());
  app.use("/api", requireAuth, createChatsRouter());

  // Legacy non-/api mounts kept temporarily for compatibility with older clients.
  app.use("/", requireAuth, createRouter());
  app.use("/", requireAuth, createWikiRouter());
  app.use("/", requireAuth, createKnowledgeRouter());
  app.use("/", requireAuth, createCalendarRouter());
  app.use("/", requireAuth, createProvidersRouter());
  app.use("/", requireAuth, createChatsRouter());

  // JSON error handler — catches any unhandled Express errors (including async throws
  // in route handlers) and returns a JSON response instead of Express's default HTML page.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[server] Unhandled route error:', message);
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
    res.status(status).json({ ok: false, error: message });
  });

  const server = http.createServer(app);
  const wss = createGateway(server);
  initCron(wss);

  server.listen(PORT, () => {
    const config = getConfig();
    const publicHost = config.publicHost || "localhost";
    console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[server] Public URL: http://${publicHost}:${PORT}`);
    console.log(`[server] Health: http://${publicHost}:${PORT}/api/health`);
    console.log(`[server] WebSocket: ws://${publicHost}:${PORT}?token=<opaque-token>`);
    console.log(`[server] Keep your server/.env private.`);
    console.log(`[server] Pair another device later with: npm run token:issue -- --label \"iPad\"`);
    // Auto-migrate legacy chats to inbox on startup
    migrateToInbox().catch((err) => console.warn("[chats] Migration warning:", err));
  });

  const shutdown = () => {
    console.log("[server] Shutting down...");
    // Terminate WebSocket clients first so HTTP server can close immediately
    for (const client of wss.clients) client.terminate();
    wss.close(() => {
      server.close(() => {
        console.log("[server] Closed.");
        process.exit(0);
      });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
});

// Intercept process.exit() to log the caller stack before exiting
const _originalExit = process.exit.bind(process);
(process as any).exit = (code?: number) => {
  console.error("[server] process.exit called with code:", code, new Error().stack);
  _originalExit(code);
};

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
