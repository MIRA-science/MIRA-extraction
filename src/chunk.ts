/**
 * chunk.ts — SECTION-AWARE chunking with WHOLE-PAPER coverage.
 *
 * Markdown-ish input (a "# title" line, "## Section" headings) is chunked on
 * SECTION boundaries: whole sections pack greedily into windows under the
 * budget, and the paper title is prepended to every window so each piece
 * carries the paper's frame. A single section that alone exceeds the budget is
 * split into sub-windows at paragraph boundaries with a small overlap (only
 * then do we split mid-section). Plain text (no headings — e.g. pdf.js output)
 * degrades gracefully to paragraph-boundary windows with the same overlap.
 *
 * NOTHING IS DROPPED: there is no window cap — back-matter and the reference
 * list ride along in their own trailing chunk(s), and a 500K-char paper simply
 * becomes more pieces. (The merge + consolidation passes reassemble the whole.)
 *
 * Ported upstream by SciOS from the RRGI deployment's chunker (chunk.mjs,
 * field-tested on the RRGI import corpus). Last synced: 2026-08-10.
 */

/** Body budget per chunk (chars) AND the single-call threshold: the engine
 *  takes the one-call path at or under it (the free nemotron chain reads whole
 *  papers — 1M-token context), so only oversize papers chunk, at this budget
 *  per piece, with full consolidation after. Matches the RRGI deployment. */
export const CHUNK_BUDGET = 100_000;
const OVERLAP = 600; // only used when a lone oversized section must be split

export interface Chunk {
  index: number;
  text: string;
  sections: string[]; // the headings this chunk covers (for reports)
}

interface Section {
  heading: string;
  body: string;
  text: string; // heading + body
}

/** Parse into { title, sections }. Plain text yields one heading-less section. */
function parseSections(raw: string): { title: string; sections: Section[] } {
  const lines = raw.split(/\r?\n/);
  let title = "";
  const acc: { heading: string; lines: string[] }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^#{2,3}\s+(.*)$/);
    if (h1 && !h2 && !title) { title = h1[1].trim(); continue; }
    if (h2) {
      if (cur) acc.push(cur);
      cur = { heading: line.trim(), lines: [] };
      continue;
    }
    if (!cur) cur = { heading: "", lines: [] }; // preamble before the first ## (or the whole paper, for plain text)
    cur.lines.push(line);
  }
  if (cur) acc.push(cur);
  return {
    title,
    sections: acc
      .map((s) => {
        const body = s.lines.join("\n").trim();
        const text = ((s.heading ? s.heading + "\n\n" : "") + body).trim();
        return { heading: s.heading, body, text };
      })
      .filter((s) => s.text),
  };
}

/** Split one oversized section into overlapping sub-windows at paragraph breaks. */
function splitSection(section: Section, budget: number): { text: string }[] {
  const paras = section.body.split(/\n{2,}/);
  const windows: string[] = [];
  let buf = "";
  const flush = () => { if (buf.trim()) windows.push(buf.trim()); };
  for (const p of paras) {
    if (buf && buf.length + 2 + p.length > budget) {
      flush();
      const tail = buf.slice(-OVERLAP);
      buf = tail + "\n\n" + p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  flush();
  const head = section.heading ? section.heading + "\n\n" : "";
  return windows.map((w, i) => ({ text: head + (i ? "(section continued)\n\n" : "") + w }));
}

/** Chunk the raw text. Returns { title, chunks } — always ≥1 chunk for non-empty text. */
export function chunkPaper(raw: string, { budget = CHUNK_BUDGET }: { budget?: number } = {}): {
  title: string;
  chunks: Chunk[];
} {
  const { title, sections } = parseSections(raw);
  const titleLine = title ? `# ${title}\n\n` : "";
  const titleLen = titleLine.length;
  const chunks: { text: string; sections: string[] }[] = [];
  let buf: Section[] = [];
  let bufLen = 0;

  const push = () => {
    if (!buf.length) return;
    chunks.push({
      text: titleLine + buf.map((s) => s.text).join("\n\n"),
      sections: buf.map((s) => s.heading || "(preamble)"),
    });
    buf = [];
    bufLen = 0;
  };

  for (const s of sections) {
    const room = budget - titleLen;
    if (s.text.length > room) {
      // oversized lone section: flush what we have, then split this one
      push();
      for (const [i, part] of splitSection(s, room).entries()) {
        chunks.push({ text: titleLine + part.text, sections: [(s.heading || "(preamble)") + (i || sections.length > 1 ? " [split]" : "")] });
      }
      continue;
    }
    if (bufLen && bufLen + s.text.length + 2 > room) push();
    buf.push(s);
    bufLen += s.text.length + 2;
  }
  push();

  return { title, chunks: chunks.map((c, i) => ({ index: i, ...c })) };
}
