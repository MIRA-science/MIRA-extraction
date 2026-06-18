/** Shapes the client consumes from /api/extract (mirrors the parent library's output). */

export type NodeType = "question" | "claim" | "evidence" | "study" | "source";

export interface PaperInfo {
  title?: string;
  doi?: string;
  license?: string;
  authors?: { name: string; orcid?: string }[];
}

export interface BuiltNode {
  id: string;
  collection: string;
  record: Record<string, unknown>;
}

export interface Edge {
  relation: string;
  subject: string;
  object: string;
  anchor?: string;
}

export interface BuiltGraph {
  nodes: BuiltNode[];
  edges: Edge[];
  dangling: Edge[];
  ungrammatical: { edge: Edge; why: string }[];
}

export interface ExtractResponse {
  source: string;
  model: string;
  truncated: boolean;
  fullChars: number;
  chunks: number;
  paper: PaperInfo | null;
  built: BuiltGraph;
  extractedText: string;
  error?: string;
}

/** node id (q1/c2/…) → its node type, derived from the record collection. */
export function nodeTypeOf(collection: string): NodeType {
  return (collection.split(".").pop() || "claim") as NodeType;
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
