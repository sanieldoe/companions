import { Router, type Request, type Response } from "express";
import { reindex } from "./reindex.js";
import { queryKnowledge } from "./query.js";
import { findDuplicates } from "./lint-dupes.js";
import { synthesiseKnowledge } from "../agent.js";

export function createKnowledgeRouter(): Router {
  const router = Router();

  /**
   * POST /knowledge/reindex
   * Walk wiki/ and journal/, embed changed files, update LanceDB.
   */
  router.post("/knowledge/reindex", async (_req: Request, res: Response) => {
    try {
      const result = await reindex();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[knowledge] reindex error:", err);
      res.status(500).json({ error: "Reindex failed", detail: String(err) });
    }
  });

  /**
   * POST /knowledge/query  body: { question: string, topK?: number }
   * Returns relevant chunks + formatted context for LLM injection.
   */
  router.post("/knowledge/query", async (req: Request, res: Response) => {
    const { question, topK } = req.body as { question?: string; topK?: number };
    if (!question || typeof question !== "string") {
      res.status(400).json({ error: "question is required" });
      return;
    }
    try {
      const result = await queryKnowledge(question, typeof topK === "number" ? topK : 6);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[knowledge] query error:", err);
      res.status(500).json({ error: "Query failed", detail: String(err) });
    }
  });

  /**
   * POST /knowledge/ask  body: { question: string, topK?: number, filter?: string[] }
   * Retrieves relevant pages (Karpathy-style: full content) then asks the LLM to synthesise an answer.
   */
  router.post("/knowledge/ask", async (req: Request, res: Response) => {
    const { question, topK, filter } = req.body as { question?: string; topK?: number; filter?: string[] };
    if (!question || typeof question !== "string") {
      res.status(400).json({ error: "question is required" });
      return;
    }

    try {
      const result = await queryKnowledge(
        question,
        typeof topK === "number" ? topK : 6,
        Array.isArray(filter) ? filter : undefined,
      );

      if (result.sources.filter(s => s !== "wiki/_index.md").length === 0) {
        res.json({ ok: true, answer: "I don't have anything in my knowledge base about that.", sources: [] });
        return;
      }

      // Synthesise using the same Pi SDK session/model as Saniel/Ruse
      const answer = await synthesiseKnowledge(result.answer, question);
      res.json({ ok: true, answer, sources: result.chunks });
    } catch (err) {
      console.error("[knowledge] ask error:", err);
      res.status(500).json({ error: "Ask failed", detail: String(err) });
    }
  });

  /**
   * GET /knowledge/dupes
   * Find near-duplicate wiki pages by cosine similarity >= 0.88.
   */
  router.get("/knowledge/dupes", async (_req: Request, res: Response) => {
    try {
      const dupes = await findDuplicates();
      res.json({ ok: true, dupes });
    } catch (err) {
      console.error("[knowledge] dupes error:", err);
      res.status(500).json({ error: "Dupe check failed", detail: String(err) });
    }
  });

  return router;
}
