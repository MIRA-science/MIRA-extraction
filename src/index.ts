/**
 * Public surface of the MIRA extractor.
 *
 *   import { decompose } from "mira-extraction";
 *   const res = await decompose({ file: "paper.pdf" }, { apiKey });
 *   res.jsonld   // canonical MIRA JSON-LD (the headline output)
 *   res.nodes    // the classified records (one id namespace)
 *   res.edges    // the legal relations
 *   res.dropped  // everything rejected, with reasons
 *   res.report   // the projection's honesty report
 *
 * Developed by SciOS; ported upstream from the extraction engine of RRGI
 * (https://graph.scios.tech), the production MIRA deployment.
 */

export { decompose, type DecomposeOptions, type DecomposeResult } from "./decompose.ts";
export { decomposeText, FALLBACK_PIECE_BUDGET, parseGraph, type CoreOptions, type CoreProgress, type CoreResult, type PieceFlake } from "./core.ts";
export { extractText } from "./extract.ts";
export {
  classifyGraph,
  cleanAnchor,
  cleanPaper,
  EDGE_GRAMMAR,
  NODE_CLASSES,
  type ClassifiedGraph,
  type CleanEdge,
  type CleanNode,
  type NodeClass,
  type PaperInfo,
  type RawEdge,
  type RawGraph,
  type RawNode,
} from "./grammar.ts";
export { SYSTEM_MESSAGE, USER_PREAMBLE_PAPER, USER_PREAMBLE_SECTION } from "./prompt.ts";
export { CHUNK_BUDGET, chunkPaper, type Chunk } from "./chunk.ts";
export { mergeGraphs, type MergedGraph, type MergeStats } from "./merge.ts";
export {
  applyConsolidation,
  CONSOLIDATE_MAX_NODES,
  CONSOLIDATE_SYSTEM_MESSAGE,
  consolidateUserMessage,
  MERGEABLE_TYPES,
  parseVerdict,
  type ConsolidatedGraph,
  type ConsolidateStats,
  type ConsolidationVerdict,
} from "./consolidate.ts";
export { DEFAULT_MODEL, streamChat, type ChatMessage, type TransportOptions, type TransportResult } from "./transport.ts";
export { toMiraJsonld, type MiraJsonldOptions, type MiraJsonldReport } from "./to-mira-jsonld.ts";
