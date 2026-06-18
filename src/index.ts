/**
 * MIRA Graph Extractor — public library API.
 *
 *   import { decompose } from "mira-graph-extractor";
 *   const result = await decompose({ file: "paper.pdf" }, { apiKey });
 *   // result.built.nodes  → the record-shaped question/claim/evidence/source nodes
 *   // result.built.edges  → the legal relations
 *   // result.built.dangling / .ungrammatical → edges the grammar rejected (reported, not dropped)
 *
 * Extract a research paper into a proposed MIRA graph via one LLM call. It
 * signs nothing and publishes nothing — the result is a DRAFT for human review.
 */
export { decompose } from "./decompose.ts";
export type { DecomposeResult, DecomposeOptions } from "./decompose.ts";
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
} from "./decompose.ts";
export { buildGraph, cleanAnchor, EDGE_GRAMMAR, TYPE_TO_COLLECTION } from "./grammar.ts";
export type { RawGraph, RawNode, RawEdge, BuiltGraph, BuiltNode, PaperInfo } from "./grammar.ts";
export { extractText } from "./extract.ts";
