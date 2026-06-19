/**
 * core.ts — the PURE, environment-agnostic extraction pipeline: the prompt, the
 * OpenRouter call, chunking, merging, and record-building. It has NO Node-only imports
 * (no fs/path, no PDF reader), so it runs unchanged in Node AND the browser. `decompose.ts`
 * layers file reading on top for the CLI; a browser app imports `decomposeText` directly.
 *
 * MODEL POLICY: Mistral Large, and ONLY Mistral Large. There is no fallback chain. A weak
 * fallback model under this (deliberately thorough) prompt collapses the graph to a handful
 * of nodes; we would rather fail loudly than silently return a degraded graph. A failed call
 * is retried against the SAME model, never a different one.
 */
import { buildGraph, type RawGraph, type RawNode, type BuiltGraph, type PaperInfo } from "./grammar.ts";

// The one model. No fallback — see MODEL POLICY above. PRIMARY_MODEL is kept as an alias.
export const MODEL = "mistralai/mistral-large";
export const PRIMARY_MODEL = MODEL;

// Per-call input budget. A paper longer than this is split into overlapping windows, each
// decomposed with its own call; the graphs are merged. Generous output budget — a graph is
// many small records, and a truncated JSON reply is a hard parse failure.
export const MAX_INPUT_CHARS = 40_000;
export const CHUNK_OVERLAP_CHARS = 2_500; // overlap so a claim spanning a window boundary still lands in one window whole
export const MAX_CHUNKS = 8; // safety cap on windows (~300K chars of coverage); a longer tail is flagged truncated
export const MAX_OUTPUT_TOKENS = 10_000;
// A dense 40K-char window can take a couple of minutes for Mistral Large to decompose fully;
// 90s was too tight and timed out mid-graph. Windows run in PARALLEL (see decomposeText), so a
// generous per-window timeout still fits inside a single function's time budget.
export const ATTEMPT_TIMEOUT_MS = 240_000;
export const CALL_RETRIES = 1; // retries PER window on a *transient* failure — same model, never a fallback; timeouts are not retried
// When a wall-clock budget (deadlineMs) is set, don't START another (minutes-long) window
// unless at least this much budget remains, and reserve this margin for the final
// merge/build/flush — so a long paper returns a clean PARTIAL graph instead of being killed
// mid-window by a serverless time limit.
export const WINDOW_MIN_BUDGET_MS = 90_000;
export const BUDGET_RESERVE_MS = 15_000;
// Model output is non-deterministic in length and occasionally truncates mid-JSON; re-ask the
// model this many extra times when a reply won't parse before falling back to salvaging a partial.
export const PARSE_RETRIES = 1;

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

/** Strip a surrounding ```code fence. The closing fence is optional — a truncated reply omits it. */
function stripFence(content: string): string {
  return content.trim().replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
}

/**
 * JSON.parse into a RawGraph, requiring a `nodes` array. A missing `edges` array (e.g. a reply
 * truncated before it was emitted) defaults to empty rather than failing the whole graph.
 */
function coerceGraph(s: string): RawGraph | null {
  let g: any;
  try { g = JSON.parse(s); } catch { return null; }
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  if (!Array.isArray(g.nodes)) return null;
  if (!Array.isArray(g.edges)) g.edges = [];
  return g as RawGraph;
}

/**
 * Best-effort recovery of a truncated JSON object (the model hit its output-token cap mid-graph):
 * trim back to the last completed element, then append the closers needed to balance the still-open
 * brackets — yielding the largest valid graph the reply got to. `s` must start at the opening '{'.
 */
function repairTruncatedJson(s: string): string {
  let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "}" || c === "]") lastSafe = i; // a complete value ends here
  }
  if (lastSafe < 0) return s;
  const head = s.slice(0, lastSafe + 1);
  const need: string[] = [];
  inStr = false; esc = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") need.push("}");
    else if (c === "[") need.push("]");
    else if (c === "}" || c === "]") need.pop();
  }
  return head + need.reverse().join("");
}

/** Strict parse: a clean JSON body or the first {…} span. Throws if neither parses (no salvage). */
export function parseGraphStrict(content: string): RawGraph {
  const t = stripFence(content);
  const start = t.indexOf("{");
  const span = start >= 0 ? t.slice(start, t.lastIndexOf("}") + 1) : "";
  const g = coerceGraph(t) || (span ? coerceGraph(span) : null);
  if (!g) throw new Error("no parseable {nodes,edges} object in model output");
  return g;
}

/** Salvage a partial graph from a truncated/garbled reply. Returns null if nothing is usable. */
export function salvageGraph(content: string): RawGraph | null {
  const t = stripFence(content);
  const start = t.indexOf("{");
  if (start < 0) return null;
  const body = t.slice(start);
  return coerceGraph(body) || coerceGraph(repairTruncatedJson(body));
}

/**
 * Parse the model's reply into a RawGraph. Strips a ```fence, tolerates surrounding prose, and —
 * when the reply is truncated (the model hit its output cap mid-graph, which varies run to run) —
 * salvages the largest valid prefix instead of discarding everything. Throws with the raw snippet
 * only when nothing at all is recoverable.
 */
export function parseGraph(content: string): RawGraph {
  try { return parseGraphStrict(content); } catch { /* fall through to salvage */ }
  const salvaged = salvageGraph(content);
  if (salvaged) return salvaged;
  throw new Error(`could not parse a {nodes,edges} graph from model output:\n${content.slice(0, 500)}`);
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

// One OpenRouter call to the ONE model — no `models` fallback list in the body. Works in
// Node and the browser (uses fetch/AbortController). Returns { ok, content, model } or
// { ok:false, reason }.
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
    // OpenRouter keeps long non-streaming calls alive by injecting SSE-style comment lines
    // (": OPENROUTER PROCESSING") into the body; the real JSON object follows. Strip any such
    // comment lines before parsing, else JSON.parse chokes on the leading ":" — which surfaces
    // as a "non-JSON response body" only on slow (large-paper) extractions.
    const rawText = await resp.text();
    const jsonText = rawText
      .split("\n")
      .filter((line) => !line.trimStart().startsWith(":"))
      .join("\n")
      .trim();
    let data: any;
    try {
      data = JSON.parse(jsonText);
    } catch {
      const snippet = rawText.slice(0, 200).replace(/\s+/g, " ").trim();
      return { ok: false, reason: `non-JSON response body (HTTP ${resp.status})${snippet ? ` — ${snippet}` : ""}` };
    }
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
    // Don't retry a timeout — it would just time out again and burn the time budget. Retry
    // only transient failures (rate limits, 5xx, dropped connections).
    if (reason.startsWith("timeout after")) break;
    if (attempt < retries) await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`model call failed (${opts.model}, no fallback): ${reason}`);
}

export interface CoreResult {
  model: string;
  truncated: boolean;
  fullChars: number;
  chunks: number;
  paper: PaperInfo | null;
  raw: RawGraph;
  built: BuiltGraph;
}
/** Progress events emitted by decomposeText as the pipeline advances (for UI status display). */
export type CoreProgress =
  | { stage: "chunking"; chunks: number; truncated: boolean }
  | { stage: "window"; index: number; total: number }
  | { stage: "partial"; done: number; total: number; reason: "budget" | "error" }
  | { stage: "merging"; chunks: number }
  | { stage: "building" };

export interface CoreOptions {
  /** OpenRouter API key (required — core does not read env). */
  apiKey: string;
  /** stamped into provenance.wasAttributedTo. A placeholder DID is fine — nothing is signed. */
  attributedTo?: string;
  /** tags every record so a paper's records are findable as a set (default "paper"). */
  slug?: string;
  /** per-window input size (default 40,000). */
  maxInputChars?: number;
  /** chars of overlap between adjacent windows (default 2,500). */
  chunkOverlap?: number;
  /** max number of windows (default 8); a longer tail is left uncovered and flagged truncated. */
  maxChunks?: number;
  /** the model id (default mistralai/mistral-large). There is no fallback. */
  model?: string;
  /** retries per window on a failed call — same model (default 1). */
  retries?: number;
  /** extra times to re-ask the model when a reply won't parse, before salvaging a partial (default 1). */
  parseRetries?: number;
  timeoutMs?: number;
  /**
   * Wall-clock budget in ms for the whole decomposition (e.g. a serverless function's time
   * limit minus a margin). Windows are processed sequentially until the budget is nearly spent;
   * a paper too long to finish in time returns a PARTIAL graph (truncated=true) for the sections
   * that completed, rather than failing. Omit (default) for no limit — the CLI processes all windows.
   */
  deadlineMs?: number;
  /** optional progress reporter — fired as chunking, per-window calls, and graph-building advance. */
  onProgress?: (event: CoreProgress) => void;
}

/**
 * Decompose already-extracted paper TEXT into a proposed MIRA graph. Short papers are one
 * call; long papers are split into overlapping windows, each decomposed and then merged.
 * Pure of any file/Node API — safe to call from a browser. Throws on a missing key, a failed
 * model call (no fallback), or unparseable output.
 */
export async function decomposeText(text: string, opts: CoreOptions): Promise<CoreResult> {
  const apiKey = (opts.apiKey || "").trim();
  if (!apiKey) throw new Error("no OpenRouter API key — pass opts.apiKey");

  const fullChars = text.length;
  const model = opts.model ?? MODEL;
  const { chunks, coveredTo } = chunkText(
    text,
    opts.maxInputChars ?? MAX_INPUT_CHARS,
    opts.chunkOverlap ?? CHUNK_OVERLAP_CHARS,
    opts.maxChunks ?? MAX_CHUNKS,
  );
  const tailUncovered = coveredTo < fullChars; // text beyond the MAX_CHUNKS window cap
  opts.onProgress?.({ stage: "chunking", chunks: chunks.length, truncated: tailUncovered });

  // Process windows SEQUENTIALLY (the free tier allows ~1 concurrent request). If a wall-clock
  // budget is set, stop before it runs out and return whatever completed — a clean partial beats
  // a function killed mid-window. A failed window (timeout/transient) likewise yields a partial
  // unless it's the very first, where we have nothing to return.
  const perWindowTimeout = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const parseRetries = opts.parseRetries ?? PARSE_RETRIES;
  const deadline = opts.deadlineMs && opts.deadlineMs > 0 ? Date.now() + opts.deadlineMs : Infinity;
  const rawGraphs: RawGraph[] = [];
  let usedModel = model;
  let stoppedEarly = false;
  let salvagedAny = false;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && deadline - Date.now() < WINDOW_MIN_BUDGET_MS) {
      stoppedEarly = true;
      opts.onProgress?.({ stage: "partial", done: rawGraphs.length, total: chunks.length, reason: "budget" });
      break;
    }
    opts.onProgress?.({ stage: "window", index: i + 1, total: chunks.length });
    const messages = [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: `Decompose this paper into a MIRA graph. Return ONLY the JSON object.\n\n---\n${chunks[i]}` },
    ];

    // A reply can truncate mid-JSON (output length is non-deterministic); re-ask the model a
    // couple of times before falling back to salvaging whatever parsed.
    let graph: RawGraph | null = null;
    let lastContent = "";
    let windowErr: unknown;
    for (let attempt = 0; attempt <= parseRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (attempt > 0 && remaining < WINDOW_MIN_BUDGET_MS) break; // no budget to re-ask → salvage below
      const timeoutMs = Number.isFinite(remaining)
        ? Math.max(30_000, Math.min(perWindowTimeout, remaining - BUDGET_RESERVE_MS))
        : perWindowTimeout;
      let content: string;
      try {
        const r = await callModel(apiKey, messages, { model, timeoutMs }, opts.retries ?? CALL_RETRIES);
        usedModel = r.model || model;
        content = r.content;
      } catch (e) {
        windowErr = e; // network/timeout — don't burn budget re-asking; salvage isn't possible
        break;
      }
      lastContent = content;
      try {
        graph = parseGraphStrict(content);
        break; // clean parse — done
      } catch (e) {
        windowErr = e; // unparseable (often a truncated reply) — re-ask if attempts remain
      }
    }
    if (!graph && lastContent) {
      graph = salvageGraph(lastContent); // best-effort partial from a truncated/garbled reply
      if (graph) salvagedAny = true;
    }

    if (graph) {
      rawGraphs.push(graph);
    } else if (rawGraphs.length === 0) {
      // Nothing salvageable from the first window — fail loudly with the most useful message.
      if (lastContent) throw new Error(`could not parse a {nodes,edges} graph from model output:\n${lastContent.slice(0, 500)}`);
      throw windowErr instanceof Error ? windowErr : new Error(String(windowErr ?? "extraction failed"));
    } else {
      stoppedEarly = true;
      opts.onProgress?.({ stage: "partial", done: rawGraphs.length, total: chunks.length, reason: "error" });
      break;
    }
  }

  const truncated = tailUncovered || stoppedEarly || salvagedAny;
  if (rawGraphs.length > 1) opts.onProgress?.({ stage: "merging", chunks: rawGraphs.length });
  const raw = rawGraphs.length === 1 ? rawGraphs[0] : mergeGraphs(rawGraphs);
  opts.onProgress?.({ stage: "building" });
  const built = buildGraph(raw, opts.attributedTo ?? "did:plc:PLACEHOLDER", opts.slug ?? "paper");
  const paper = cleanPaper(raw.paper);

  return { model: usedModel, truncated, fullChars, chunks: rawGraphs.length, paper, raw, built };
}
