import type { NodeType } from "./types.ts";

/** Visual identity per node class — RRGI's own palette (core.css), kept in
 *  lock-step by hand so this tool reads like the RRGI viewer. Request wears
 *  RRGI's issue violet (Request is the schema's issue-shaped class). */
export const NODE_STYLE: Record<NodeType, { color: string; glow: string; label: string }> = {
  Question: { color: "#5cb1e6", glow: "rgba(92,177,230,0.25)", label: "Question" },
  Claim: { color: "#ecc049", glow: "rgba(236,192,73,0.25)", label: "Claim" },
  Evidence: { color: "#54d6a0", glow: "rgba(84,214,160,0.25)", label: "Evidence" },
  Study: { color: "#d98ab0", glow: "rgba(217,138,176,0.25)", label: "Study" },
  Protocol: { color: "#8fbf6f", glow: "rgba(143,191,111,0.25)", label: "Protocol" },
  SourceDocument: { color: "#cd8a5b", glow: "rgba(205,138,91,0.22)", label: "Source" },
  Request: { color: "#b18cf2", glow: "rgba(177,140,242,0.25)", label: "Request" },
};

/** Color per relation — RRGI's relation palette; the request relations share
 *  the Request violet. */
export const EDGE_COLOR: Record<string, string> = {
  addresses: "#5cb1e6",
  supports: "#46c98a",
  opposes: "#e76a5b",
  describesActivity: "#cf86c0",
  grounds: "#5ec0b0",
  follows: "#74b7d6",
  request_for: "#b18cf2",
  request_target: "#b18cf2",
};

export const NODE_ORDER: NodeType[] = ["Question", "Claim", "Evidence", "Study", "Protocol", "SourceDocument", "Request"];
