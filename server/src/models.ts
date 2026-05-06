/**
 * models.ts
 *
 * Parses model spec strings from env vars into pi-ai Model objects.
 *
 * Supported formats:
 *   anthropic:claude-sonnet-4-6          → getModel("anthropic", "claude-sonnet-4-6")
 *   openai:gpt-4o                        → getModel("openai", "gpt-4o")
 *   openai-compat:<baseUrl>:<modelId>    → custom Model<"openai-completions">
 *
 * Examples for local LLMs:
 *   openai-compat:http://localhost:11434/v1:llama3.2          (Ollama)
 *   openai-compat:http://localhost:8080/v1:mlx-model-name     (MLX-LM / omlx)
 *   openai-compat:http://localhost:1234/v1:local-model        (LM Studio)
 */

import { getModel } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

const OPENAI_COMPAT_PREFIX = "openai-compat:";

/**
 * Build a Model object for an OpenAI-compatible local endpoint.
 * The model ID is sent verbatim in the `model` field of API requests.
 */
function buildOpenAICompatModel(baseUrl: string, modelId: string, apiKey?: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai-compat",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  };
}

/**
 * Parse a model spec string into a pi-ai Model object.
 * Returns undefined if spec is empty or missing.
 *
 * @throws Error if spec format is unrecognised or provider/model not found
 */
export function parseModelSpec(spec: string | undefined, apiKey?: string): Model<any> | undefined {
  if (!spec) return undefined;

  // openai-compat:<baseUrl>:<modelId>
  // baseUrl may contain colons (http://...) so split on the last colon only
  if (spec.startsWith(OPENAI_COMPAT_PREFIX)) {
    const rest = spec.slice(OPENAI_COMPAT_PREFIX.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon === -1) {
      throw new Error(`[models] Invalid openai-compat spec "${spec}". Expected: openai-compat:<baseUrl>:<modelId>`);
    }
    const baseUrl = rest.slice(0, lastColon);
    const modelId = rest.slice(lastColon + 1);
    if (!baseUrl || !modelId) {
      throw new Error(`[models] Invalid openai-compat spec "${spec}". baseUrl and modelId must be non-empty.`);
    }
    return buildOpenAICompatModel(baseUrl, modelId, apiKey);
  }

  // provider:modelId — delegate to pi-ai's built-in model registry
  const colonIdx = spec.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`[models] Invalid model spec "${spec}". Expected format: provider:modelId or openai-compat:baseUrl:modelId`);
  }
  const provider = spec.slice(0, colonIdx) as any;
  const modelId = spec.slice(colonIdx + 1) as any;

  try {
    return getModel(provider, modelId);
  } catch {
    throw new Error(`[models] Unknown provider or model: "${spec}". Check that provider and modelId are correct.`);
  }
}

/**
 * Resolve the model for a given personality mode.
 *
 * Precedence (highest to lowest):
 *   1. CREW_MODEL / TWEET_MODEL  (non-chat modes only)
 *   2. DEFAULT_MODEL
 *   3. undefined (Pi SDK picks from ~/.pi/agent settings)
 */
export function resolveModelForMode(mode: string): Model<any> | undefined {
  const modeKey = mode.toUpperCase();
  const spec = process.env[`${modeKey}_MODEL`] ?? process.env.DEFAULT_MODEL;
  const apiKey = process.env[`${modeKey}_MODEL_KEY`] ?? process.env.DEFAULT_MODEL_KEY;
  if (!spec) return undefined;
  const model = parseModelSpec(spec, apiKey);
  if (model) {
    console.log(`[models] Mode "${mode}" using model: ${model.name} (${model.api} @ ${model.baseUrl})`);
  }
  return model;
}

/** Resolve DEFAULT_MODEL — used for the shared Mentor/Shapeshifter chat session. */
export function resolveDefaultModel(): Model<any> | undefined {
  const spec = process.env.DEFAULT_MODEL;
  const apiKey = process.env.DEFAULT_MODEL_KEY;
  if (!spec) return undefined;
  const model = parseModelSpec(spec, apiKey);
  if (model) {
    console.log(`[models] Chat session using model: ${model.name} (${model.api} @ ${model.baseUrl})`);
  }
  return model;
}

/** Resolve FALLBACK_MODEL — used when the primary model is unreachable. */
export function resolveFallbackModel(): Model<any> | undefined {
  const spec = process.env.FALLBACK_MODEL;
  const apiKey = process.env.FALLBACK_MODEL_KEY;
  if (!spec) return undefined;
  try {
    const model = parseModelSpec(spec, apiKey);
    if (model) console.log(`[models] Fallback model: ${model.name}`);
    return model;
  } catch (err) {
    console.warn(`[models] Invalid FALLBACK_MODEL spec: ${err}`);
    return undefined;
  }
}
