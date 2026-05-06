import { getAllForDupeCheck } from "./store.js";

const DUPE_THRESHOLD = 0.88;

export interface DupeResult {
  fileA: string;
  fileB: string;
  similarity: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function findDuplicates(): Promise<DupeResult[]> {
  const pages = await getAllForDupeCheck();
  const dupes: DupeResult[] = [];

  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const sim = cosineSimilarity(pages[i].vector, pages[j].vector);
      if (sim >= DUPE_THRESHOLD) {
        dupes.push({ fileA: pages[i].path, fileB: pages[j].path, similarity: Math.round(sim * 1000) / 1000 });
      }
    }
  }

  return dupes.sort((a, b) => b.similarity - a.similarity);
}
