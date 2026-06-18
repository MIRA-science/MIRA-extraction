import type { NodeType } from "./types.ts";

/** Visual identity per node type — kept in one place so the graph, legend and inspector agree. */
export const NODE_STYLE: Record<NodeType, { color: string; glow: string; label: string }> = {
  question: { color: "#f5b301", glow: "rgba(245,179,1,0.25)", label: "Question" },
  claim: { color: "#3b82f6", glow: "rgba(59,130,246,0.25)", label: "Claim" },
  evidence: { color: "#10b981", glow: "rgba(16,185,129,0.25)", label: "Evidence" },
  study: { color: "#a855f7", glow: "rgba(168,85,247,0.25)", label: "Study" },
  source: { color: "#94a3b8", glow: "rgba(148,163,184,0.22)", label: "Source" },
};

/** Color per relation type. */
export const EDGE_COLOR: Record<string, string> = {
  addresses: "#60a5fa",
  supports: "#34d399",
  opposes: "#f87171",
  describes: "#c084fc",
  grounds: "#fbbf24",
};

export const NODE_ORDER: NodeType[] = ["question", "claim", "evidence", "study", "source"];
