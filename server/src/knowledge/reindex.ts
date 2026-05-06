import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { chunkMarkdown } from "./chunk.js";
import { embed } from "./embed.js";
import { upsertChunks, deleteByPath, getAllPaths, type ChunkRecord } from "./store.js";

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

const INDEX_FOLDERS = ["wiki", "journal", "projects", "phrases"] as const;

function md5(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

async function walkMarkdown(dir: string, relBase: string): Promise<{ rel: string; abs: string }[]> {
  const results: { rel: string; abs: string }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_") || entry.name === "log.md") continue;
    const abs = path.join(dir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdown(abs, rel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push({ rel, abs });
    }
  }
  return results;
}

export interface ReindexResult {
  indexed: string[];
  skipped: string[];
  removed: string[];
  errors: string[];
}

export async function reindex(): Promise<ReindexResult> {
  const result: ReindexResult = { indexed: [], skipped: [], removed: [], errors: [] };

  // Gather all current files
  const allFiles: { rel: string; abs: string }[] = [];
  for (const folder of INDEX_FOLDERS) {
    const dir = path.join(VAULT_ROOT, folder);
    allFiles.push(...(await walkMarkdown(dir, folder)));
  }

  // Load existing index state
  const existingIndex = await getAllPaths();
  const currentPaths = new Set(allFiles.map((f) => f.rel));

  // Remove deleted files from index
  for (const [indexedPath] of existingIndex) {
    if (!currentPaths.has(indexedPath)) {
      await deleteByPath(indexedPath).catch(() => {});
      result.removed.push(indexedPath);
    }
  }

  // Process files concurrently (max 4 at a time)
  const CONCURRENCY = 4;
  for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
    const batch = allFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ rel, abs }) => {
      let content: string;
      let stat: fs.Stats;
      try {
        [content, stat] = await Promise.all([
          fs.promises.readFile(abs, "utf-8"),
          fs.promises.stat(abs),
        ]);
      } catch {
        result.errors.push(rel);
        return;
      }

      const mtime = stat.mtime.toISOString();
      const hash = md5(content);
      const existing = existingIndex.get(rel);

      if (existing && existing.mtime === mtime && existing.hash === hash) {
        result.skipped.push(rel);
        return;
      }

      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) {
        result.skipped.push(rel);
        return;
      }

      try {
        const texts = chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.text}` : c.text));
        const vectors = await embed(texts);

        const records: ChunkRecord[] = chunks.map((chunk, i) => ({
          id: `${rel}::${chunk.chunk_idx}`,
          path: rel,
          chunk_idx: chunk.chunk_idx,
          heading: chunk.heading,
          text: chunk.text,
          mtime,
          hash,
          vector: vectors[i],
        }));

        await upsertChunks(records);
        result.indexed.push(rel);
      } catch (err) {
        console.error(`[knowledge] reindex error for ${rel}:`, err);
        result.errors.push(rel);
      }
    }));
  }

  return result;
}
