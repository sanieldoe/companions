import path from "node:path";
import fs from "node:fs";

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

export interface QueryResult {
  answer: string;
  sources: string[];
  chunks: { path: string; heading: string; text: string; score?: number }[];
}

/**
 * Karpathy-style query: read _index.md, keyword-match to find relevant pages,
 * then read those pages IN FULL for synthesis context. No vector DB.
 */
export async function queryKnowledge(question: string, topK: number = 6, filter?: string[]): Promise<QueryResult> {
  const indexPath = path.join(VAULT_ROOT, "wiki", "_index.md");
  let indexContent = "";
  try { indexContent = await fs.promises.readFile(indexPath, "utf-8"); } catch { /* no index yet */ }

  if (!indexContent.trim()) {
    return { answer: "No wiki index found.", sources: [], chunks: [] };
  }

  // Keyword-score each index entry
  const questionWords = new Set((question.toLowerCase().match(/\b\w{4,}\b/g) ?? []));
  const scored: { path: string; score: number }[] = [];

  for (const line of indexContent.split('\n')) {
    const pathMatch = line.match(/\[\[([^\]|]+)/);
    if (!pathMatch) continue;
    const p = pathMatch[1].trim();
    if (!p.startsWith('wiki/') || p.includes('_index') || p.includes('log.md')) continue;

    // Apply optional path filter
    if (filter && filter.length > 0 && !filter.some(f => p.startsWith(f))) continue;

    const words = line.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
    const score = words.filter(w => {
      if (questionWords.has(w)) return true;
      if (w.length >= 5) return [...questionWords].some(qw => qw.length >= 5 && (qw.includes(w) || w.includes(qw)));
      return false;
    }).length;
    if (score > 0) scored.push({ path: p, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const topPaths = scored.slice(0, topK).map(e => e.path);

  if (topPaths.length === 0) {
    return { answer: "No relevant knowledge found.", sources: [], chunks: [] };
  }

  console.log(`[query] ${topPaths.length} pages matched from index for: ${question.slice(0, 60)}`);

  // Read full pages
  const contextParts: string[] = [];
  const sources: string[] = [];

  for (const p of topPaths) {
    const abs = path.join(VAULT_ROOT, p.endsWith(".md") ? p : `${p}.md`);
    try {
      const content = await fs.promises.readFile(abs, "utf-8");
      contextParts.push(`[Source: ${p}]\n${content}`);
      sources.push(p);
    } catch { /* file may have been deleted */ }
  }

  // Always include the index
  contextParts.push(`[Source: wiki/_index.md]\n${indexContent}`);
  if (!sources.includes("wiki/_index.md")) sources.push("wiki/_index.md");

  return {
    answer: contextParts.join("\n\n---\n\n"),
    sources,
    // chunks field kept for API compatibility — return one entry per page
    chunks: sources.filter(s => s !== "wiki/_index.md").map(s => ({
      path: s,
      heading: "",
      text: contextParts.find(c => c.startsWith(`[Source: ${s}]`))?.slice(0, 500) ?? "",
    })),
  };
}
