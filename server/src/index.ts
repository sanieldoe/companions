import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { initKeys, authTokenHandler, requireAuth } from "./auth.js";
import { createRouter } from "./routes.js";
import { createGateway } from "./gateway.js";
import { initAgent } from "./agent.js";
import { createWikiRouter } from "./wiki.js";
import { createKnowledgeRouter } from "./knowledge/router.js";
import { createCalendarRouter, calendarOAuthCallback } from "./calendar.js";
import { createProvidersRouter } from "./providers.js";
import { createChatsRouter, migrateToInbox } from "./chats.js";
import { initCron } from "./cron.js";
import { createRhythmsRouter } from "./rhythms.js";
import { createAdminRouter, pushLog } from "./admin.js";
import { createInstallRouter } from "./install.js";
import type { Mode } from "./routes.js";

// Intercept console output into the admin log buffer
(['log', 'warn', 'error'] as const).forEach((level) => {
  const orig = (console[level] as (...a: unknown[]) => void).bind(console);
  (console[level] as (...a: unknown[]) => void) = (...args: unknown[]) => {
    orig(...args);
    pushLog({ ts: new Date().toISOString(), level, msg: args.map(String).join(' ') });
  };
});

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_MODE: Mode = "mentor";

async function main() {
  initKeys();

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
  const appDist = path.resolve(__dirname, '../../app/dist');
  app.use('/app', express.static(appDist));
  app.get('/app/*', (_req, res) => res.sendFile(path.join(appDist, 'index.html')));
  // Expo web build uses absolute paths for /_expo and /assets
  app.use('/_expo', express.static(path.join(appDist, '_expo')));
  app.use('/assets', express.static(path.join(appDist, 'assets')));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(webDist, 'dashboard.html')));

  // Install API endpoints must mount before the HTML catch-all for /install/*
  app.use("/", createInstallRouter());
  app.get('/install', (_req, res) => res.sendFile(path.join(webDist, 'install.html')));
  app.get('/install/*', (_req, res) => res.sendFile(path.join(webDist, 'install.html')));

  // /ping is unauthenticated — useful for pm2 health checks and monitoring
  app.get("/ping", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/auth/token", authTokenHandler);
  app.get("/calendar/callback", calendarOAuthCallback);

  app.use(requireAuth);
  app.use("/", createRouter());
  app.use("/", createWikiRouter());
  app.use("/", createKnowledgeRouter());
  app.use("/", createCalendarRouter());
  app.use("/", createProvidersRouter());
  app.use("/", createChatsRouter());
  app.use("/", createRhythmsRouter());
  app.use("/", createAdminRouter());

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
    console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[server] WebSocket: ws://0.0.0.0:${PORT}?token=<jwt>`);
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


main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
