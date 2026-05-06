/**
 * providers.ts
 *
 * REST endpoints for LLM provider management and per-mode model selection.
 *
 * GET  /providers                      — all models grouped by provider, with auth status
 * POST /providers/:provider/apikey     — store an API key
 * DELETE /providers/:provider/apikey   — remove an API key
 * GET  /providers/oauth                — list OAuth-capable providers (e.g. Copilot)
 * POST /providers/:provider/login      — start OAuth device-code flow
 * GET  /modes/:mode/model              — get current model for a mode
 * PUT  /modes/:mode/model              — set model for a mode (hot-swaps live session)
 */

import { Router, type Request, type Response } from "express";
import { MODES, type Mode } from "./routes.js";
import {
  getSharedAuthStorage,
  getSharedModelRegistry,
  setSessionModel,
  writeModeModel,
  getModeModel,
  getChatModel,
  writeChatModel,
  CHAT_MODES,
} from "./agent.js";

// Pending OAuth flows keyed by provider
const pendingLogins = new Map<string, { authUrl: string; instructions?: string; done: boolean; error?: string }>();

export function createProvidersRouter(): Router {
  const router = Router();

  /**
   * GET /providers
   * Returns all models grouped by provider, with auth status per provider.
   */
  router.get("/providers", (_req: Request, res: Response) => {
    try {
      const registry = getSharedModelRegistry();
      const auth = getSharedAuthStorage();
      const all = registry.getAll();

      // Group models by provider
      const byProvider: Record<string, { authStatus: object; models: object[] }> = {};
      for (const model of all) {
        if (!byProvider[model.provider]) {
          byProvider[model.provider] = {
            authStatus: registry.getProviderAuthStatus(model.provider),
            models: [],
          };
        }
        byProvider[model.provider].models.push({
          provider: model.provider,
          id: model.id,
          name: model.name,
          api: model.api,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          cost: model.cost,
        });
      }

      // Also include OAuth providers that may not have models but can be authed
      for (const p of auth.getOAuthProviders()) {
        if (!byProvider[p.id]) {
          byProvider[p.id] = {
            authStatus: auth.getAuthStatus(p.id),
            models: [],
          };
        }
      }

      res.json({ ok: true, providers: byProvider });
    } catch (err) {
      console.error("[providers] getAll error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /providers/oauth
   * Returns list of OAuth-capable providers.
   */
  router.get("/providers/oauth", (_req: Request, res: Response) => {
    try {
      const providers = getSharedAuthStorage().getOAuthProviders();
      res.json({ ok: true, providers: providers.map((p) => ({ id: p.id })) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * POST /providers/:provider/apikey
   * Body: { key: string }
   * Stores an API key for the given provider.
   */
  router.post("/providers/:provider/apikey", (req: Request, res: Response) => {
    const { provider } = req.params;
    const { key } = req.body as { key?: string };
    if (!key || typeof key !== "string" || !key.trim()) {
      res.status(400).json({ error: "key is required" });
      return;
    }
    try {
      getSharedAuthStorage().set(provider, { type: "api_key", key: key.trim() });
      // Refresh registry so new auth is reflected immediately
      getSharedModelRegistry().refresh();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * DELETE /providers/:provider/apikey
   * Removes the stored credential for the given provider.
   */
  router.delete("/providers/:provider/apikey", (req: Request, res: Response) => {
    const { provider } = req.params;
    try {
      getSharedAuthStorage().remove(provider);
      getSharedModelRegistry().refresh();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * POST /providers/:provider/login
   * Starts an OAuth flow. Returns { authUrl, instructions? }.
   * The user opens the URL in a browser; poll GET /providers/:provider/login/status for completion.
   */
  router.post("/providers/:provider/login", async (req: Request, res: Response) => {
    const { provider } = req.params;

    // Return existing in-progress flow
    if (pendingLogins.has(provider)) {
      const pending = pendingLogins.get(provider)!;
      if (!pending.done) {
        res.json({ ok: true, authUrl: pending.authUrl, instructions: pending.instructions });
        return;
      }
      pendingLogins.delete(provider);
    }

    const state: { authUrl: string; instructions?: string; done: boolean; error?: string } = {
      authUrl: "",
      done: false,
    };
    pendingLogins.set(provider, state);

    // Run OAuth in background; capture auth URL via onAuth callback.
    // NOTE: Pi SDK's Copilot provider calls onAuth(url, instructions) as two positional
    // args (not an OAuthAuthInfo object), so we must handle both forms.
    getSharedAuthStorage()
      .login(provider, {
        onAuth: (infoOrUrl: any, maybeInstructions?: string) => {
          if (typeof infoOrUrl === "string") {
            state.authUrl = infoOrUrl;
            state.instructions = maybeInstructions;
          } else {
            state.authUrl = infoOrUrl?.url ?? "";
            state.instructions = infoOrUrl?.instructions;
          }
        },
        onPrompt: async () => "",
        onProgress: (msg: string) => console.log(`[providers] OAuth ${provider}: ${msg}`),
      })
      .then(() => {
        state.done = true;
        getSharedModelRegistry().refresh();
        console.log(`[providers] OAuth login complete for ${provider}`);
      })
      .catch((err: unknown) => {
        state.done = true;
        state.error = String(err);
        console.error(`[providers] OAuth login failed for ${provider}:`, err);
      });

    // Wait briefly for the auth URL to be generated
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));

    if (state.authUrl) {
      // Extract user_code from instructions like "Enter code: XXXX-XXXX"
      const codeMatch = state.instructions?.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
      res.json({
        ok: true,
        authUrl: state.authUrl,
        instructions: state.instructions,
        userCode: codeMatch?.[0] ?? null,
      });
    } else {
      res.status(500).json({ error: `Failed to start OAuth flow for ${provider}` });
    }
  });

  /**
   * GET /providers/:provider/login/status
   * Returns { done, error? } for a pending OAuth flow.
   */
  router.get("/providers/:provider/login/status", (req: Request, res: Response) => {
    const { provider } = req.params;
    const state = pendingLogins.get(provider);
    if (!state) {
      res.json({ ok: true, done: true });
      return;
    }
    res.json({ ok: true, done: state.done, error: state.error });
  });

  /**
   * GET /modes/:mode/model
   * Returns the stored model for a mode, or null if using default.
   */
  router.get("/modes/:mode/model", (req: Request, res: Response) => {
    const { mode } = req.params;
    if (mode === "chat") {
      res.json({ ok: true, model: getChatModel() });
      return;
    }
    if (!(MODES as readonly string[]).includes(mode)) {
      res.status(400).json({ error: `Unknown mode: ${mode}` });
      return;
    }
    if (CHAT_MODES.has(mode as Mode)) {
      res.status(400).json({ error: `Use /modes/chat/model for chat model settings` });
      return;
    }
    const entry = getModeModel(mode as Mode);
    res.json({ ok: true, model: entry ?? null });
  });

  /**
   * PUT /modes/:mode/model
   * Body: { provider: string; modelId: string } | null
   * Hot-swaps the model for the given mode's live session and persists it.
   * Pass null body to reset to default.
   */
  router.put("/modes/:mode/model", async (req: Request, res: Response) => {
    const { mode } = req.params;

    if (mode === "chat") {
      const body = req.body as { provider?: string; modelId?: string } | null;
      if (!body || (!body.provider && !body.modelId)) {
        writeChatModel(null);
        res.json({ ok: true, model: null });
        return;
      }
      const { provider, modelId } = body;
      if (!provider || !modelId) {
        res.status(400).json({ error: "provider and modelId are required" });
        return;
      }
      writeChatModel({ provider, modelId });
      res.json({ ok: true, model: { provider, modelId } });
      return;
    }

    if (!(MODES as readonly string[]).includes(mode)) {
      res.status(400).json({ error: `Unknown mode: ${mode}` });
      return;
    }
    if (CHAT_MODES.has(mode as Mode)) {
      res.status(400).json({ error: `Use /modes/chat/model for chat model settings` });
      return;
    }

    const body = req.body as { provider?: string; modelId?: string } | null;
    if (!body || (!body.provider && !body.modelId)) {
      writeModeModel(mode as Mode, null);
      res.json({ ok: true, model: null });
      return;
    }
    const { provider, modelId } = body;
    if (!provider || !modelId) {
      res.status(400).json({ error: "provider and modelId are required" });
      return;
    }
    try {
      await setSessionModel(mode as Mode, provider, modelId);
      res.json({ ok: true, model: { provider, modelId } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("auth") || msg.includes("API key") ? 403 : 500;
      res.status(status).json({ error: msg });
    }
  });

  return router;
}
