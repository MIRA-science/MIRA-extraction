/** Shapes the client consumes from /api/extract (mirrors the parent library's output). */

export type NodeType =
  | "Question"
  | "Claim"
  | "Evidence"
  | "Study"
  | "Protocol"
  | "SourceDocument"
  | "Request";

export interface PaperInfo {
  title?: string;
  doi?: string;
  license?: string;
  authors?: { name: string; orcid?: string }[];
}

export interface ExtractNode {
  id: string;
  type: NodeType;
  text: string;
  description?: string;
  doi?: string; // SourceDocument only
  url?: string; // SourceDocument only
  anchor?: string;
}

export interface Edge {
  relation: string;
  subject: string;
  object: string;
  anchor?: string;
}

export interface ExtractResponse {
  source: string;
  models: string[];
  pieces: number;
  piecesDecomposed: number;
  flakes: { piece: number; why: string }[];
  paper: PaperInfo | null;
  nodes: ExtractNode[];
  edges: Edge[];
  dropped: {
    nodes: { node: unknown; why: string }[];
    danglingEdges: { edge: Edge; why: string }[];
    ungrammaticalEdges: { edge: Edge; why: string }[];
  };
  extractedText: string;
  /** exact duplicates folded mechanically at merge time */
  mergeFolded?: number;
  /** the consolidation pass's stats (multi-piece papers) */
  consolidation?: {
    recordsFolded: number;
    edgesAdded: number;
    groupsRejected: number;
    proposedRejected: number;
    skipped?: string;
  };
  error?: string;
}

/**
 * Does the anchor quote appear in the source text?
 * "exact" → verbatim substring; "normalized" → matches once whitespace is collapsed
 * (PDF extraction often differs only in spacing); "missing" → not found.
 */
export type AnchorMatch = "exact" | "normalized" | "missing";
export function checkAnchor(text: string, anchor: string | undefined): AnchorMatch | null {
  if (!anchor) return null;
  if (!text) return null;
  if (text.includes(anchor)) return "exact";
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(text).includes(norm(anchor)) ? "normalized" : "missing";
}
