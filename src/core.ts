/**
 * core.ts — the extraction engine: text in → classified MIRA graph out.
 *
 * The flow matches the RRGI deployment's live behavior exactly:
 *
 *   WHOLE PAPER, ONE CALL. A text at or under the single-call threshold
 *   (CHUNK_BUDGET, 100K chars — most papers; the free nemotron chain reads
 *   whole papers) goes to the model in ONE call. If that call keeps failing
 *   and the text is big enough to split, the engine falls back to
 *   proven-reliable 24K pieces — the paper is still read in full.
 *
 *   OVERSIZE → PIECES + CONSOLIDATION. A longer text is read in section-aware
 *   pieces (whole-paper coverage, no cap), each classified, mechanically
 *   merged, then CONSOLIDATED: one model call over the whole record list that
 *   names same-proposition duplicates (folded) and the cross-piece relations
 *   no single read could see (applied only if grammar-legal; everything
 *   re-checked).
 *
 * A piece that stays unparseable after its retries is recorded as a FLAKE in
 * the result and the run continues — the report says exactly which pieces are
 * missing, so a caller can fail loudly or accept the partial honestly.
 *
 * Developed by SciOS; ported upstream from the RRGI deployment's extraction
 * engine (field-tested at graph.scios.tech). Last synced: 2026-08-10.
 */

import { CHUNK_BUDGET, chunkPaper } from "./chunk.ts";
import {
  classifyGraph,
  cleanPaper,
  type ClassifiedGraph,
  type CleanEdge,
  type CleanNode,
  type PaperInfo,
  type RawGraph,
} from "./grammar.ts";
import { SYSTEM_MESSAGE, USER_PREAMBLE_PAPER, USER_PREAMBLE_SECTION } from "./prompt.ts";
import { mergeGraphs, type MergeStats } from "./merge.ts";
import {
  applyConsolidation,
  CONSOLIDATE_MAX_NODES,
  CONSOLIDATE_SYSTEM_MESSAGE,
  consolidateUserMessage,
  parseVerdict,
  type ConsolidateStats,
} from "./consolidate.ts";
import { streamChat, type TransportOptions } from "./transport.ts";

/** When a whole-paper single call keeps dying, fall back to pieces of this
 *  proven-reliable size — the paper is still read in full, with consolidation
 *  after. Production never dead-ends on a slow serve. (RRGI's constant.) */
export const FALLBACK_PIECE_BUDGET = 24_000;

// ---------------------------------------------------------------------------
// Parsing the model's reply.
// ---------------------------------------------------------------------------

/**
 * Parse the model's reply into a { nodes, edges } graph. Models sometimes
 * fence the JSON or add a stray sentence; strip a single wrapping ```fence,
 * else fall back to the first {...} span. Null on total failure.
 */
export function parseGraph(content: string): RawGraph | null {
  let t = content.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  const tryParse = (s: string): RawGraph | null => {
    try {
      const g = JSON.parse(s);
      if (g && Array.isArray(g.nodes) && Array.isArray(g.edges)) return g as RawGraph;
    } catch { /* fall through */ }
    return null;
  };
  let g = tryParse(t);
  if (!g) g = tryParse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  return g;
}

// ---------------------------------------------------------------------------
// Options + result.
// ---------------------------------------------------------------------------

export interface CoreOptions extends Omit<TransportOptions, "onToken"> {
  /** Single-call threshold AND per-piece budget in chars (default CHUNK_BUDGET, 100K). */
  chunkBudget?: number;
  /** Run the consolidation pass on multi-piece papers (default true). */
  consolidate?: boolean;
  /** Extra attempts when a reply parses to no graph (default 2). */
  parseRetries?: number;
  /** Pause between piece calls, ms (default 1500 — free-tier manners). */
  paceMs?: number;
  /** Progress hook for CLIs/UIs. */
  onProgress?: (p: CoreProgress) => void;
}

export type CoreProgress =
  | { phase: "chunked"; pieces: number; chars: number }
  | { phase: "decomposing"; piece: number; pieces: number }
  | { phase: "generating"; chars: number; kind: "reasoning" | "content" } // the model is THINKING or WRITING (streamed chars so far) — queued vs producing, made visible
  | { phase: "decomposed"; piece: number; pieces: number; nodes: number; edges: number }
  | { phase: "piece-failed"; piece: number; pieces: number; why: string }
  | { phase: "fallback"; why: string } // the whole-paper call failed → reading in pieces instead
  | { phase: "consolidating"; records: number }
  | { phase: "consolidated"; folded: number; edgesAdded: number };

export interface PieceFlake {
  piece: number;
  why: string;
}

export interface CoreResult {
  /** The final classified graph (merged + consolidated), one id namespace (g0…). */
  nodes: CleanNode[];
  edges: CleanEdge[];
  /** Everything rejected on the way, accumulated across pieces. */
  dropped: ClassifiedGraph["dropped"];
  /** Extraction-time paper attribution (grounded-in-the-text only), or null. */
  paper: PaperInfo | null;
  /** Pieces that produced no usable graph — the run's honesty ledger. */
  flakes: PieceFlake[];
  stats: {
    chars: number;
    pieces: number;
    piecesDecomposed: number;
    merge: MergeStats;
    consolidation: ConsolidateStats;
  };
  /** Every model that actually answered, in order of first use. */
  models: string[];
  /** Per-call usage receipts (cost accounting — the free-only receipt). */
  usage: unknown[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const emptyConsolidation = (): ConsolidateStats => ({
  groupsApplied: 0,
  groupsRejected: 0,
  recordsFolded: 0,
  edgesAdded: 0,
  proposedRejected: 0,
  edgesDroppedByFold: 0,
});

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export async function decomposeText(text: string, options: CoreOptions): Promise<CoreResult> {
  if (!text || !text.trim()) throw new Error("no text to decompose");
  const budget = options.chunkBudget ?? CHUNK_BUDGET;
  const parseRetries = Math.max(0, options.parseRetries ?? 2);
  const paceMs = options.paceMs ?? 1500;
  const progress = options.onProgress ?? (() => {});

  const models: string[] = [];
  const usage: unknown[] = [];

  /** One decompose call (with parse-failure retries — a truncated/garbled JSON
   *  reply is NOT an HTTP failure, so the transport's retry never fires for it).
   *  Returns the raw graph, or null with the reason in `whyRef`. */
  // Surface generation liveness: the transport sees every streamed token; a
  // throttled progress event distinguishes "queued" from "the model is writing".
  let lastGenEmit = 0;
  const onToken = (chars: number, kind: "reasoning" | "content") => {
    const now = Date.now();
    if (now - lastGenEmit >= 1200) {
      lastGenEmit = now;
      progress({ phase: "generating", chars, kind });
    }
  };

  const callDecompose = async (body: string, preamble: string, label: string, whyRef: { why: string }) => {
    let raw: RawGraph | null = null;
    try {
      for (let attempt = 0; attempt <= parseRetries && !raw; attempt++) {
        const res = await streamChat(
          [
            { role: "system", content: SYSTEM_MESSAGE },
            { role: "user", content: `${preamble}\n\n---\n${body}` },
          ],
          { ...options, onToken },
          label,
        );
        if (res.model && !models.includes(res.model)) models.push(res.model);
        if (res.usage) usage.push(res.usage);
        raw = parseGraph(res.content);
        if (!raw) {
          whyRef.why = "reply parsed to no {nodes, edges} graph";
          if (attempt < parseRetries) await sleep(paceMs);
        }
      }
    } catch (e: any) {
      whyRef.why = String(e?.message || e).slice(0, 300);
    }
    return raw;
  };

  // ---- THE SINGLE-CALL PATH: whole paper, one call --------------------------
  let pieceBudget = budget;
  let singleCallFailure: string | null = null;
  if (text.length <= budget) {
    progress({ phase: "chunked", pieces: 1, chars: text.length });
    progress({ phase: "decomposing", piece: 1, pieces: 1 });
    const whyRef = { why: "" };
    const raw = await callDecompose(text, USER_PREAMBLE_PAPER, "the whole-paper call", whyRef);
    if (raw) {
      const g = classifyGraph(raw);
      progress({ phase: "decomposed", piece: 1, pieces: 1, nodes: g.nodes.length, edges: g.edges.length });
      const merged = mergeGraphs([g]);
      return {
        nodes: merged.nodes,
        edges: merged.edges,
        dropped: g.dropped,
        paper: cleanPaper(raw.paper),
        flakes: [],
        stats: {
          chars: text.length,
          pieces: 1,
          piecesDecomposed: 1,
          merge: merged.stats,
          consolidation: { ...emptyConsolidation(), skipped: "single call — nothing cross-piece" },
        },
        models,
        usage,
      };
    }
    // The whole-paper call kept failing. Too small to split → surface the real
    // error; otherwise read the paper in proven-size pieces instead.
    if (text.length <= FALLBACK_PIECE_BUDGET)
      throw new Error(`the whole-paper call failed: ${whyRef.why || "unknown"}`);
    singleCallFailure = whyRef.why;
    pieceBudget = FALLBACK_PIECE_BUDGET;
    progress({ phase: "fallback", why: whyRef.why });
  }

  // ---- THE PIECES PATH: chunk → decompose each → merge → consolidate --------
  const { chunks } = chunkPaper(text, { budget: pieceBudget });
  progress({ phase: "chunked", pieces: chunks.length, chars: text.length });

  const classified: ClassifiedGraph[] = [];
  const dropped: ClassifiedGraph["dropped"] = { nodes: [], danglingEdges: [], ungrammaticalEdges: [] };
  const flakes: PieceFlake[] = [];
  let paper: PaperInfo | null = null;

  for (const c of chunks) {
    progress({ phase: "decomposing", piece: c.index + 1, pieces: chunks.length });
    const whyRef = { why: "" };
    const raw = await callDecompose(c.text, USER_PREAMBLE_SECTION, `piece ${c.index + 1}/${chunks.length}`, whyRef);
    if (!raw) {
      flakes.push({ piece: c.index, why: whyRef.why || "unparseable after retries" });
      progress({ phase: "piece-failed", piece: c.index + 1, pieces: chunks.length, why: whyRef.why });
    } else {
      if (!paper) paper = cleanPaper(raw.paper);
      const g = classifyGraph(raw);
      dropped.nodes.push(...g.dropped.nodes);
      dropped.danglingEdges.push(...g.dropped.danglingEdges);
      dropped.ungrammaticalEdges.push(...g.dropped.ungrammaticalEdges);
      classified.push(g);
      progress({ phase: "decomposed", piece: c.index + 1, pieces: chunks.length, nodes: g.nodes.length, edges: g.edges.length });
    }
    if (c.index < chunks.length - 1) await sleep(paceMs);
  }

  if (!classified.length)
    throw new Error(
      singleCallFailure
        ? `the whole-paper call failed (${singleCallFailure}) and no fallback piece produced a usable graph`
        : `no piece produced a usable graph (${flakes.length} of ${chunks.length} failed; first: ${flakes[0]?.why || "?"})`,
    );

  // MERGE — one id namespace + mechanical dedup.
  const merged = mergeGraphs(classified);

  // CONSOLIDATE — merges + cross-piece edges, everything re-checked.
  let nodes = merged.nodes;
  let edges = merged.edges;
  let consolidation = emptyConsolidation();
  if (options.consolidate === false) {
    consolidation.skipped = "disabled by option";
  } else if (classified.length < 2) {
    consolidation.skipped = "single piece — nothing cross-piece";
  } else if (merged.nodes.length < 2) {
    consolidation.skipped = "fewer than 2 records";
  } else if (merged.nodes.length > CONSOLIDATE_MAX_NODES) {
    consolidation.skipped = `${merged.nodes.length} records > ${CONSOLIDATE_MAX_NODES} cap`;
  } else {
    progress({ phase: "consolidating", records: merged.nodes.length });
    try {
      await sleep(paceMs);
      const res = await streamChat(
        [
          { role: "system", content: CONSOLIDATE_SYSTEM_MESSAGE },
          { role: "user", content: consolidateUserMessage(merged.nodes, merged.edges) },
        ],
        { ...options, onToken },
        "the consolidation pass",
      );
      if (res.model && !models.includes(res.model)) models.push(res.model);
      if (res.usage) usage.push(res.usage);
      const verdict = parseVerdict(res.content);
      if (verdict) {
        const applied = applyConsolidation({ nodes, edges }, verdict);
        nodes = applied.nodes;
        edges = applied.edges;
        consolidation = applied.stats;
        progress({ phase: "consolidated", folded: applied.stats.recordsFolded, edgesAdded: applied.stats.edgesAdded });
      } else {
        consolidation.skipped = "unusable model reply — mechanical merge only";
      }
    } catch (e: any) {
      consolidation.skipped = `failed (${String(e?.message || e).slice(0, 160)}) — mechanical merge only`;
    }
  }

  return {
    nodes,
    edges,
    dropped,
    paper,
    flakes,
    stats: {
      chars: text.length,
      pieces: chunks.length,
      piecesDecomposed: classified.length,
      merge: merged.stats,
      consolidation,
    },
    models,
    usage,
  };
}
