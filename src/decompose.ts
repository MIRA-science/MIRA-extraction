/**
 * decompose() — a paper (PDF/txt/md file, or raw text) → a validated-shape
 * MIRA graph: the classified records, the extraction report, and the
 * canonical MIRA JSON-LD.
 *
 * This is the Node entry point: it adds FILE reading (pdf/txt/md via
 * extractText) on top of the pure engine in core.ts, runs the pipeline, then
 * projects the result to MIRA JSON-LD (to-mira-jsonld.ts). It signs nothing
 * and publishes nothing; the result is a DRAFT for human review.
 */
import { basename } from "node:path";
import { extractText } from "./extract.ts";
import { decomposeText, type CoreOptions, type CoreResult } from "./core.ts";
import { toMiraJsonld, type MiraJsonldOptions, type MiraJsonldReport } from "./to-mira-jsonld.ts";

export interface DecomposeOptions extends Partial<CoreOptions>, Omit<MiraJsonldOptions, "slug"> {
  /** OpenRouter API key. Falls back to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
  /** Short name for the run (default: the file's base name, else the paper title). */
  slug?: string;
}

export interface DecomposeResult extends CoreResult {
  /** the input file path, or "(text)" when called with raw text. */
  source: string;
  /** the run's short name (used for local IRIs and output naming). */
  slug: string;
  /** the canonical MIRA JSON-LD document — the headline output. */
  jsonld: Record<string, unknown>;
  /** the projection's honesty report (counts, stamps, omissions). */
  report: MiraJsonldReport;
}

/**
 * Decompose a paper into a MIRA graph. Pass `{ file }` (pdf/txt/md) or `{ text }`.
 * Throws on a missing key, unreadable input, or when no piece of the paper
 * produced a usable graph; partial piece failures come back in `flakes`.
 */
export async function decompose(
  input: { text?: string; file?: string },
  opts: DecomposeOptions = {},
): Promise<DecomposeResult> {
  const apiKey = (opts.apiKey || process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("no OpenRouter API key — set OPENROUTER_API_KEY or pass opts.apiKey");

  const text = input.text ?? (input.file ? await extractText(input.file) : undefined);
  if (text == null) throw new Error("decompose() needs { text } or { file }");

  const result = await decomposeText(text, { ...opts, apiKey });

  const slug = opts.slug || (input.file ? basename(input.file).replace(/\.[^.]+$/, "") : "") || result.paper?.title || "extraction";
  const { jsonld, report } = toMiraJsonld(
    { nodes: result.nodes, edges: result.edges, paper: result.paper },
    {
      slug,
      baseIri: opts.baseIri,
      generatedAt: opts.generatedAt,
      creatorName: opts.creatorName,
      contextOverride: opts.contextOverride,
    },
  );

  return { source: input.file ?? "(text)", slug, jsonld, report, ...result };
}
