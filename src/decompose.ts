/**
 * decompose() — a paper (PDF/txt/md file, or raw text) → a PROPOSED MIRA graph.
 * This is the Node entry point: it adds FILE reading (pdf/txt/md via extractText) on top of
 * the pure pipeline in core.ts, then delegates to decomposeText(). It signs nothing and
 * publishes nothing; the result is a DRAFT for review.
 *
 * The pure logic (prompt, OpenRouter call, chunking, merge, record-building) lives in
 * core.ts so it can be reused unchanged in the browser. See MODEL POLICY there.
 */
import { basename } from "node:path";
import { extractText } from "./extract.ts";
import { decomposeText, type CoreResult, type CoreOptions } from "./core.ts";

export interface DecomposeResult extends CoreResult {
  /** the input file path, or "(text)" when called with raw text. */
  source: string;
}
export interface DecomposeOptions extends Partial<CoreOptions> {
  /** OpenRouter API key. Falls back to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
}

/**
 * Decompose a paper into a proposed MIRA graph. Pass `{ file }` (pdf/txt/md) or `{ text }`.
 * Throws on a missing key, unreadable input, a failed model call (no fallback), or
 * unparseable output.
 */
export async function decompose(
  input: { text?: string; file?: string },
  opts: DecomposeOptions = {},
): Promise<DecomposeResult> {
  const apiKey = (opts.apiKey || process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("no OpenRouter API key — set OPENROUTER_API_KEY or pass opts.apiKey");

  const text = input.text ?? (input.file ? await extractText(input.file) : undefined);
  if (text == null) throw new Error("decompose() needs { text } or { file }");

  const slug = opts.slug ?? (input.file ? basename(input.file).replace(/\.[^.]+$/, "") : "paper");
  const result = await decomposeText(text, { ...opts, apiKey, slug });
  return { source: input.file ?? "(text)", ...result };
}

// Back-compat re-exports — callers (index.ts, tests, the CLI) keep importing these from here.
export {
  MODEL,
  PRIMARY_MODEL,
  MAX_INPUT_CHARS,
  CHUNK_OVERLAP_CHARS,
  MAX_CHUNKS,
  SYSTEM_MESSAGE,
  parseGraph,
  cleanPaper,
  chunkText,
  mergeGraphs,
  decomposeText,
} from "./core.ts";
export type { CoreResult, CoreOptions } from "./core.ts";
