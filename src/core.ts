/**
 * core.ts — the extraction engine: text in → classified MIRA graph out.
 *
 * The flow: WHOLE PAPER, ONE CALL — always. A text at or under SINGLE_CALL_MAX
 * (400K chars) goes to the model in one call. A larger text throws
 * PaperTooBigError; a call that keeps failing throws with the reason. The
 * engine never chunks and never falls back. (chunk.ts / merge.ts /
 * consolidate.ts stay in the repo unwired — the starting point for a future
 * chunking system; `flakes` and the pieces/consolidation stats survive in the
 * result shape for artifact compatibility.)
 *
 * Developed by SciOS; ported upstream from the RRGI deployment's extraction
 * engine (field-tested at graph.scios.tech). Last synced: 2026-08-10.
 */

import { SINGLE_CALL_MAX } from "./chunk.ts";
import {
  classifyGraph,
  cleanPaper,
  type ClassifiedGraph,
  type CleanEdge,
  type CleanNode,
  type PaperInfo,
  type RawGraph,
} from "./grammar.ts";
import { SYSTEM_MESSAGE, USER_PREAMBLE_PAPER } from "./prompt.ts";
import { mergeGraphs, type MergeStats } from "./merge.ts";
import { type ConsolidateStats } from "./consolidate.ts";
import { streamChat, type TransportOptions } from "./transport.ts";

/** Thrown when a text exceeds SINGLE_CALL_MAX. The engine never chunks. */
export class PaperTooBigError extends Error {
  constructor(
    public readonly chars: number,
    public readonly limit: number,
  ) {
    super(
      `the paper is ${chars.toLocaleString()} characters — over the ${limit.toLocaleString()}-character single-call limit; extraction refused (the engine never chunks)`,
    );
    this.name = "PaperTooBigError";
  }
}

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
  /** Extra attempts when a reply parses to no graph (default 2). */
  parseRetries?: number;
  /** Pause between parse-retry attempts, ms (default 4000). */
  paceMs?: number;
  /** Progress hook for CLIs/UIs. */
  onProgress?: (p: CoreProgress) => void;
}

export type CoreProgress =
  | { phase: "chunked"; pieces: number; chars: number }
  | { phase: "decomposing"; piece: number; pieces: number }
  | { phase: "generating"; chars: number; kind: "reasoning" | "content" } // the model is THINKING or WRITING (streamed chars so far) — queued vs producing, made visible
  | { phase: "decomposed"; piece: number; pieces: number; nodes: number; edges: number };

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
  if (text.length > SINGLE_CALL_MAX) throw new PaperTooBigError(text.length, SINGLE_CALL_MAX);
  const parseRetries = Math.max(0, options.parseRetries ?? 2);
  const paceMs = options.paceMs ?? 4000;
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

  // ---- THE SINGLE CALL: whole paper, one call, or a thrown error ------------
  progress({ phase: "chunked", pieces: 1, chars: text.length });
  progress({ phase: "decomposing", piece: 1, pieces: 1 });
  const whyRef = { why: "" };
  const raw = await callDecompose(text, USER_PREAMBLE_PAPER, "the whole-paper call", whyRef);
  if (!raw) throw new Error(`the whole-paper call failed: ${whyRef.why || "unknown"}`);

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
