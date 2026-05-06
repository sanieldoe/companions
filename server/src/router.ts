/**
 * router.ts
 *
 * Fast LLM-based message classifier for auto-routing the first turn
 * of a conversation to the correct personality mode.
 *
 * Uses ROUTER_MODEL env (or falls back to DEFAULT_MODEL).
 * Only supports openai-compat endpoints for now (local models are fast enough).
 */

import { parseModelSpec } from "./models.js";
import type { Mode } from "./routes.js";

const MODES: readonly Mode[] = ["mentor", "shapeshifter", "keeper", "tracker"];

const SYSTEM_PROMPT = `You are a router. Given a user message, reply with ONLY a JSON object: {"mode":"<mode>","reason":"<one short phrase>"}
Modes:
- mentor: learning, deep explanations, debugging, "why does", "explain", step-by-step
- shapeshifter: quick hacks, prototyping, "just try", creative, fast experiments, "I'm stuck"
- keeper: notes, brain dumps, "remember this", journaling, "write this down", "save this", tasks
- tracker: calendar, schedule, "what's on", emails, "what did I miss", time, events, reminders
Default to saniel if unclear. Respond with ONLY valid JSON, no markdown.`;

export async function classifyMessage(text: string): Promise<{ mode: Mode; reason: string }> {
  const spec = process.env.ROUTER_MODEL ?? process.env.DEFAULT_MODEL;
  const apiKey = process.env.ROUTER_MODEL_KEY ?? process.env.DEFAULT_MODEL_KEY;

  if (!spec) return { mode: "mentor", reason: "no router model configured" };

  let model: ReturnType<typeof parseModelSpec>;
  try {
    model = parseModelSpec(spec, apiKey);
  } catch {
    return { mode: "mentor", reason: "model parse failed" };
  }

  if (!model) return { mode: "mentor", reason: "model parse failed" };

  // Only supports openai-compat for routing (local models are fast enough)
  if (model.api !== "openai-completions" || !model.baseUrl) {
    return { mode: "mentor", reason: "router only supports openai-compat" };
  }

  const baseUrl: string = model.baseUrl;
  const modelId: string = model.id;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 500) },
        ],
        max_tokens: 60,
        temperature: 0,
        enable_thinking: false,
        stream: false,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return { mode: "mentor", reason: "router request failed" };

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content: string = data?.choices?.[0]?.message?.content ?? "";

    // Strip any accidental markdown fences
    const cleaned = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { mode?: string; reason?: string };

    const mode: Mode = MODES.includes(parsed.mode as Mode)
      ? (parsed.mode as Mode)
      : "mentor";

    return { mode, reason: parsed.reason ?? "" };
  } catch {
    return { mode: "mentor", reason: "router error" };
  }
}
