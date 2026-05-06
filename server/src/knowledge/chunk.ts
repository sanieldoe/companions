export interface Chunk {
  chunk_idx: number;
  heading: string;
  text: string;
}

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHARS = 500 * APPROX_CHARS_PER_TOKEN; // ~500 tokens
const OVERLAP_CHARS = 60 * APPROX_CHARS_PER_TOKEN; // ~60 tokens overlap

/**
 * Split markdown into chunks by H2/H3 headings.
 * Chunks that exceed MAX_CHARS are split further with overlap.
 */
export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split("\n");
  const sections: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: "", lines: [] };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (current.lines.length > 0 || current.heading) {
        sections.push(current);
      }
      current = { heading: headingMatch[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.heading) {
    sections.push(current);
  }

  const chunks: Chunk[] = [];
  let idx = 0;

  for (const section of sections) {
    const sectionText = section.lines.join("\n").trim();
    if (!sectionText) continue;

    if (sectionText.length <= MAX_CHARS) {
      chunks.push({ chunk_idx: idx++, heading: section.heading, text: sectionText });
    } else {
      // Split long sections with overlap
      let start = 0;
      while (start < sectionText.length) {
        const end = Math.min(start + MAX_CHARS, sectionText.length);
        const slice = sectionText.slice(start, end);
        chunks.push({ chunk_idx: idx++, heading: section.heading, text: slice });
        if (end >= sectionText.length) break;
        start = end - OVERLAP_CHARS;
      }
    }
  }

  return chunks;
}
