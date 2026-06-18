/**
 * decompose() — a paper (PDF/txt/md file, or raw text) → a PROPOSED MIRA graph,
 * via one or more LLM calls. The orchestrator: extract text → (split long papers into
 * overlapping windows) → call the model per window → parse → merge → build records +
 * classify edges. It signs nothing and publishes nothing; the result is a DRAFT for review.
 *
 * MODEL POLICY: Mistral Large, and ONLY Mistral Large. There is no fallback chain. A weak
 * fallback model under this (deliberately thorough) prompt collapses the graph to a handful
 * of nodes; we would rather fail loudly than silently return a degraded graph. A failed call
 * is retried against the SAME model, never a different one.
 *
 * The model is reached through OpenRouter (any OpenAI-compatible chat endpoint works
 * if you adapt callOpenRouter). Bring your own key via OPENROUTER_API_KEY / opts.apiKey.
 */
import { basename } from "node:path";
import { extractText } from "./extract.ts";
import { buildGraph, type RawGraph, type RawNode, type BuiltGraph, type PaperInfo } from "./grammar.ts";

// The one model. No fallback — see MODEL POLICY above. PRIMARY_MODEL is kept as an alias
// for older imports.
export const MODEL = "mistralai/mistral-large";
export const PRIMARY_MODEL = MODEL;

// Per-call input budget. A paper longer than this is split into overlapping windows, each
// decomposed with its own call; the graphs are merged. Generous output budget — a graph is
// many small records, and a truncated JSON reply is a hard parse failure.
export const MAX_INPUT_CHARS = 40_000;
export const CHUNK_OVERLAP_CHARS = 2_500; // overlap so a claim spanning a window boundary still lands in one window whole
export const MAX_CHUNKS = 8; // safety cap on windows (~300K chars of coverage); a longer tail is flagged truncated
export const MAX_OUTPUT_TOKENS = 10_000;
export const ATTEMPT_TIMEOUT_MS = 90_000;
export const CALL_RETRIES = 1; // retries PER window on failure — same model, never a fallback

// The extraction prompt — this IS the product. It defines the grammar the model must
// follow and the strict JSON contract it must return. Grounded but THOROUGH: extract
// everything the paper actually argues, invent nothing.
export const SYSTEM_MESSAGE = `You decompose a research paper into a MIRA GRAPH — small, citable
records connected by typed relations. You read the paper text and return ONLY a JSON object describing the graph.

NODE TYPES (the things the paper is about):
- "question" — a research question the paper investigates (an unknown posed for systematic study).
- "claim"    — a statement the authors assert: a finding, conclusion, or hypothesis. The unit you support/oppose.
- "evidence" — a specific result, observation, or interpretation of data that can support or oppose a claim.
- "study"    — a specific investigation, experiment, or analysis that PRODUCES evidence (the activity behind a result). A source describes it; it grounds evidence.
- "source"   — a DOCUMENT that reports a study: the paper itself, and works it cites (a paper, preprint, dataset, book, or article).

EDGE TYPES (relation, then the only legal endpoint types — obey these exactly):
- "addresses": subject=claim   → object=question   (a claim answers a research question)
- "supports":  subject=evidence|claim → object=claim   (strengthens a claim)
- "opposes":   subject=evidence|claim → object=claim   (weakens a claim)
- "describes": subject=source  → object=study      (a source describes the study/investigation it reports)
- "grounds":   subject=study   → object=evidence   (a study grounds/produces a piece of evidence)

OUTPUT — return ONLY this JSON object, no prose, no code fences:
{
  "paper": { "title": "...", "doi": "...", "license": "...", "authors": [ { "name": "...", "orcid": "..." } ] },
  "nodes": [
    { "id": "q1", "type": "question", "text": "...", "description": "...", "anchor": "..." },
    { "id": "c1", "type": "claim", "text": "...", "description": "...", "epistemicStatus": "claim|hypothesis|conjecture", "anchor": "..." },
    { "id": "e1", "type": "evidence", "text": "...", "description": "...", "anchor": "..." },
    { "id": "st1", "type": "study", "text": "...", "description": "...", "anchor": "..." },
    { "id": "s1", "type": "source", "text": "...", "sourceType": "paper|preprint|dataset|study|book|website", "doi": "...", "url": "...", "description": "...", "anchor": "..." }
  ],
  "edges": [
    { "relation": "addresses", "subject": "c1", "object": "q1", "anchor": "..." },
    { "relation": "describes", "subject": "s1", "object": "st1", "anchor": "..." },
    { "relation": "grounds", "subject": "st1", "object": "e1", "anchor": "..." }
  ]
}

RULES:
1. ids are short local handles (q1, c2, e3, s1) — unique within this graph; edges reference them.
2. "text" is a concise, self-contained statement (the node's label). "description" carries fuller context/reasoning;
   include it when the paper gives it, omit it otherwise.
3. GROUND EVERYTHING in the paper, but be THOROUGH. Extract EVERY distinct claim the authors assert, EVERY separate
   piece of evidence (each result, measurement, observation, or comparison is its own evidence node), every research
   question, and every cited source — one node per distinct idea, not one per topic. Split compound sentences into
   separate claim/evidence nodes. Do NOT invent claims, numbers, mechanisms, questions, or sources the paper does not
   state. If the paper does not pose a question explicitly, infer the one or two that its claims clearly answer.
4. Only emit edges whose endpoint types match the grammar above. Every subject/object MUST be an id you defined.
   PROVENANCE SPINE — a source NEVER connects directly to evidence. Model the investigation a source reports as a
   "study" node and chain source --describes--> study --grounds--> evidence. Make one study per distinct
   investigation/experiment/analysis and reuse it for every piece of evidence it produced; the paper itself is a
   source whose study is the work it reports. If you cannot identify the study behind a piece of evidence, link
   that evidence to its claim with supports/opposes and omit the source/study chain — never invent a study.
5. omit doi/url/sourceType when unknown; omit description when you have nothing real to put there. Never emit nulls.
6. Aim for a COMPLETE, fine-grained graph: capture the paper's full argument, not just its headline. Every claim
   should connect to the evidence for or against it and to the question it addresses; every piece of evidence should
   chain back through its study to a source. Stay accurate — every node must be grounded in the text — but do not
   drop a real claim or result just to keep the graph small. This is a DRAFT a human will review and approve.
7. "paper" describes the paper ITSELF, for attribution: its exact title, plus the author names, ORCID iDs, the
   paper's own DOI, and its license — each ONLY as printed in the text. "license" must be a SHORT named license
   identifier (e.g. "CC BY 4.0", "MIT"); if the text prints only a long permissions paragraph with no named
   license, OMIT the field. Omit any field — or the whole "paper" object — you cannot ground in the text.
   NEVER guess an ORCID, DOI, or license.
8. "anchor": for EVERY node — and for an edge when a single passage states the relationship (e.g. "these results
   confirm the hypothesis" grounds a supports) — copy a SHORT VERBATIM quote of about 8–15 words from the exact
   spot in the paper text that grounds the record: the sentence that states the claim, reports the evidence,
   poses the question, or cites the source. Copy it EXACTLY as printed, character for character (same casing,
   spelling, and punctuation; no "..." gaps). Do not stitch fragments from different places. OMIT "anchor" when
   no single passage grounds the record. Never put the anchor text anywhere except the "anchor" field.`;

/**
 * Parse the model's reply into a RawGraph. Models sometimes wrap JSON in a fenced
 * block or add a stray sentence; we strip a single wrapping ```fence and, failing a
 * clean parse, fall back to the first {...} span. Throws with the raw snippet on
 * total failure so you can see what the model actually did.
 */
export function parseGraph(content: string): RawGraph {
  let t = content.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  const tryParse = (s: string): RawGraph | null => {
    try {
      const g = JSON.parse(s);
      if (g && Array.isArray(g.nodes) && Array.isArray(g.edges)) return g;
    } catch { /* fall through */ }
    return null;
  };
  let g = tryParse(t);
  if (!g) {
    const span = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
    g = tryParse(span);
  }
  if (!g) throw new Error(`could not parse a {nodes,edges} graph from model output:\n${content.slice(0, 500)}`);
  return g;
}

/**
 * Clean the model's optional "paper" attribution object. Defensive: trim, drop
 * empties, accept an ORCID only in its canonical 0000-0000-0000-000X shape (a
 * malformed one is dropped, never "fixed"). Returns null when nothing real survives.
 */
export function cleanPaper(raw: unknown): PaperInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: PaperInfo = {};
  const title = str(p.title);
  if (title) out.title = title.slice(0, 512);
  const doi = str(p.doi);
  if (doi) out.doi = doi.slice(0, 256);
  const license = str(p.license);
  if (license) out.license = license.slice(0, 256);
  const authors: { name: string; orcid?: string }[] = [];
  for (const a of Array.isArray(p.authors) ? p.authors : []) {
    const name = str((a as Record<string, unknown>)?.name);
    if (!name) continue;
    const author: { name: string; orcid?: string } = { name: name.slice(0, 256) };
    const orcid = str((a as Record<string, unknown>)?.orcid).replace(/^https?:\/\/(www\.)?orcid\.org\//i, "");
    if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) author.orcid = orcid.toUpperCase();
    authors.push(author);
    if (authors.length >= 64) break;
  }
  if (authors.length) out.authors = authors;
  return Object.keys(out).length ? out : null;
}

/**
 * Split text into overlapping windows for per-window decomposition. Short text returns a
 * single window unchanged. Long text is cut on a paragraph/sentence boundary near the end
 * of each window (so a window rarely ends mid-sentence), with `overlap` chars carried into
 * the next window. Bounded by `maxChunks`; `coveredTo` is the char index actually reached
 * (less than text.length ⇒ a tail was left uncovered).
 */
export function chunkText(
  text: string,
  size: number,
  overlap: number,
  maxChunks: number,
): { chunks: string[]; coveredTo: number } {
  if (text.length <= size) return { chunks: [text], coveredTo: text.length };
  const chunks: string[] = [];
  let start = 0;
  let coveredTo = 0;
  while (start < text.length && chunks.length < maxChunks) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      // Back off to a clean boundary within the last ~15% of the window.
      const floor = start + Math.floor(size * 0.85);
      const window = text.slice(floor, end);
      const para = window.lastIndexOf("\n\n");
      const sent = para < 0 ? window.lastIndexOf(". ") : -1;
      if (para >= 0) end = floor + para + 2;
      else if (sent >= 0) end = floor + sent + 2;
    }
    chunks.push(text.slice(start, end));
    coveredTo = end;
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return { chunks, coveredTo };
}

// Normalized identity for cross-window node dedup: same type + same text (case/whitespace/
// trailing-punctuation insensitive) ⇒ the same node.
function nodeKey(type: string, text: string): string {
  return type + "::" + text.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
}

/**
 * Merge per-window raw graphs into one. Each window numbers its own ids (q1/c2/…), so we
 * namespace them per window (`c{i}_{id}`) to avoid collisions, dedup nodes by normalized
 * (type,text) — enriching the kept node with any anchor/description/doi a duplicate adds —
 * remap every edge through the dedup, and drop duplicate edges. The first window's `paper`
 * wins (the title/abstract live at the front).
 */
export function mergeGraphs(graphs: RawGraph[]): RawGraph {
  const canonByKey = new Map<string, string>(); // normalized node identity → canonical id
  const nodeById = new Map<string, RawNode>();
  const edges: RawGraph["edges"] = [];
  let paper: unknown;

  graphs.forEach((g, i) => {
    if (g?.paper && paper === undefined) paper = g.paper;
    const localToCanon = new Map<string, string>();
    for (const n of g?.nodes ?? []) {
      if (!n?.id || !n.type || !n.text) continue;
      const key = nodeKey(n.type, n.text);
      let canon = canonByKey.get(key);
      if (!canon) {
        canon = `c${i}_${n.id}`;
        canonByKey.set(key, canon);
        nodeById.set(canon, { ...n, id: canon });
      } else {
        const ex = nodeById.get(canon);
        if (ex) {
          if (!ex.anchor && n.anchor) ex.anchor = n.anchor;
          if (!ex.description && n.description) ex.description = n.description;
          if (!ex.doi && n.doi) ex.doi = n.doi;
          if (!ex.url && n.url) ex.url = n.url;
        }
      }
      localToCanon.set(n.id, canon);
    }
    for (const e of g?.edges ?? []) {
      if (!e?.relation) continue;
      const subject = localToCanon.get(e.subject);
      const object = localToCanon.get(e.object);
      if (!subject || !object) continue; // endpoint not kept in this window — let it go
      edges.push({ ...e, subject, object });
    }
  });

  const seen = new Set<string>();
  const deduped = edges.filter((e) => {
    const k = `${e.relation}|${e.subject}|${e.object}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { nodes: [...nodeById.values()], edges: deduped, paper };
}

// One OpenRouter call to the ONE model — no `models` fallback list in the body. Returns
// { ok, content, model } or { ok:false, reason }.
async function callOpenRouter(
  key: string,
  messages: { role: string; content: string }[],
  opts: { model: string; timeoutMs: number },
): Promise<{ ok: true; content: string; model: string } | { ok: false; reason: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "MIRA Graph Extractor",
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: 0.2, // low — extraction, not creative writing
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch { /* ignore */ }
      return { ok: false, reason: `HTTP ${resp.status}${detail ? ` — ${detail}` : ""}` };
    }
    let data: any;
    try { data = await resp.json(); } catch { return { ok: false, reason: "non-JSON response body" }; }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      return { ok: false, reason: "empty/missing choices[0].message.content" };
    return { ok: true, content, model: data.model || opts.model };
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? `timeout after ${opts.timeoutMs}ms` : (e?.message || String(e));
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// Call the model with retries against the SAME model (never a fallback). Throws on final
// failure with the reason — we fail loudly rather than degrade.
async function callModel(
  key: string,
  messages: { role: string; content: string }[],
  opts: { model: string; timeoutMs: number },
  retries: number,
): Promise<{ content: string; model: string }> {
  let reason = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await callOpenRouter(key, messages, opts);
    if (r.ok) return { content: r.content, model: r.model };
    reason = r.reason;
    if (attempt < retries) await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`model call failed (${opts.model}, no fallback): ${reason}`);
}

export interface DecomposeResult {
  source: string;
  model: string;
  truncated: boolean;
  fullChars: number;
  chunks: number;
  paper: PaperInfo | null;
  raw: RawGraph;
  built: BuiltGraph;
}
export interface DecomposeOptions {
  /** OpenRouter API key. Falls back to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
  /** stamped into provenance.wasAttributedTo. A placeholder DID is fine — nothing is signed. */
  attributedTo?: string;
  /** tags every record so a paper's records are findable as a set. Defaults to the filename. */
  slug?: string;
  /** per-window input size (default 40,000). Long papers are split into windows of this size. */
  maxInputChars?: number;
  /** chars of overlap between adjacent windows (default 2,500). */
  chunkOverlap?: number;
  /** max number of windows (default 8); a longer tail is left uncovered and flagged truncated. */
  maxChunks?: number;
  /** the model id (default mistralai/mistral-large). There is no fallback. */
  model?: string;
  /** retries per window on a failed call — same model (default 1). */
  retries?: number;
  timeoutMs?: number;
}

/**
 * Decompose a paper into a proposed MIRA graph. Pass `{ file }` (pdf/txt/md) or
 * `{ text }`. Short papers are one call; long papers are split into overlapping windows,
 * each decomposed and then merged. Returns the model used, the (merged) raw graph, and the
 * built record-shaped graph with its legal/dangling/ungrammatical edge split. Throws on a
 * missing key, unreadable input, a failed model call (no fallback), or unparseable output.
 */
export async function decompose(
  input: { text?: string; file?: string },
  opts: DecomposeOptions = {},
): Promise<DecomposeResult> {
  const apiKey = (opts.apiKey || process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("no OpenRouter API key — set OPENROUTER_API_KEY or pass opts.apiKey");

  const text = input.text ?? (input.file ? await extractText(input.file) : undefined);
  if (text == null) throw new Error("decompose() needs { text } or { file }");

  const fullChars = text.length;
  const model = opts.model ?? MODEL;
  const { chunks, coveredTo } = chunkText(
    text,
    opts.maxInputChars ?? MAX_INPUT_CHARS,
    opts.chunkOverlap ?? CHUNK_OVERLAP_CHARS,
    opts.maxChunks ?? MAX_CHUNKS,
  );
  const truncated = coveredTo < fullChars;

  const rawGraphs: RawGraph[] = [];
  let usedModel = model;
  for (const chunk of chunks) {
    const messages = [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: `Decompose this paper into a MIRA graph. Return ONLY the JSON object.\n\n---\n${chunk}` },
    ];
    const r = await callModel(apiKey, messages, { model, timeoutMs: opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS }, opts.retries ?? CALL_RETRIES);
    usedModel = r.model || model;
    rawGraphs.push(parseGraph(r.content));
  }

  // One window keeps the model's own ids (preserves the single-call output shape exactly);
  // multiple windows are merged with namespaced, deduped ids.
  const raw = rawGraphs.length === 1 ? rawGraphs[0] : mergeGraphs(rawGraphs);
  const slug = opts.slug ?? (input.file ? basename(input.file).replace(/\.[^.]+$/, "") : "paper");
  const built = buildGraph(raw, opts.attributedTo ?? "did:plc:PLACEHOLDER", slug);
  const paper = cleanPaper(raw.paper);

  return { source: input.file ?? "(text)", model: usedModel, truncated, fullChars, chunks: chunks.length, paper, raw, built };
}
