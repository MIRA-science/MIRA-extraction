/**
 * The editable staging model + its mutation ops, validation, and export.
 *
 * After extraction we hold the graph as ONE in-memory, mutable draft. Every edit goes
 * through `ops.*` (each returns a NEW model — React-friendly), and `validate()` re-derives
 * what's broken (empty-text nodes, dangling/ungrammatical edges) without ever deleting
 * anything. Drop is a soft-delete (restorable). Nothing leaves the browser until export.
 *
 * The grammar here MIRRORS src/grammar.ts (kept in lock-step by hand — it's a small,
 * stable table) so editing can be validated live in the client.
 */
import type { NodeType, ExtractResponse, Edge } from "./types.ts";
import { nodeTypeOf } from "./types.ts";

export const NODE_TYPES: NodeType[] = ["question", "claim", "evidence", "study", "source"];

// relation → the only legal { subject types, object types }. Mirror of src/grammar.ts.
export const EDGE_GRAMMAR: Record<string, { subj: NodeType[]; obj: NodeType[] }> = {
  addresses: { subj: ["claim"], obj: ["question"] },
  supports: { subj: ["evidence", "claim"], obj: ["claim"] },
  opposes: { subj: ["evidence", "claim"], obj: ["claim"] },
  describes: { subj: ["source"], obj: ["study"] },
  grounds: { subj: ["study"], obj: ["evidence"] },
};
export const RELATIONS = Object.keys(EDGE_GRAMMAR);

export const TYPE_TO_COLLECTION: Record<NodeType, string> = {
  question: "tech.scios.rrgi.question",
  claim: "tech.scios.rrgi.claim",
  evidence: "tech.scios.rrgi.evidence",
  study: "tech.scios.rrgi.study",
  source: "tech.scios.rrgi.source",
};

export const EPISTEMIC_STATUSES = ["claim", "hypothesis", "conjecture"];
export const SOURCE_TYPES = ["paper", "preprint", "dataset", "study", "book", "website", "article"];

export interface StageNode {
  id: string;
  type: NodeType;
  text: string;
  description?: string;
  epistemicStatus?: string;
  sourceType?: string;
  doi?: string;
  url?: string;
  anchor?: string;
  dropped?: boolean;
  added?: boolean; // authored by the user, not the model
}
export interface StageEdge {
  id: string;
  relation: string;
  subject: string;
  object: string;
  anchor?: string;
  dropped?: boolean;
  added?: boolean;
}
export interface StagePaper {
  title?: string;
  doi?: string;
  license?: string;
  authors?: { name: string; orcid?: string }[];
}
export interface StageMeta {
  source: string;
  model: string;
  truncated: boolean;
  chunks: number;
  fullChars: number;
  extractedText: string;
}
export interface StageModel {
  nodes: StageNode[];
  edges: StageEdge[];
  paper: StagePaper | null;
  meta: StageMeta;
  seq: number; // monotonic counter for new node/edge ids (n0/e1/…), collision-free vs extractor ids
}

/** Build the editable model from the extractor response. All edges (legal + dangling +
 *  ungrammatical) come in together — validate() re-derives their status live. */
export function buildStageModel(r: ExtractResponse): StageModel {
  const nodes: StageNode[] = r.built.nodes.map((n) => {
    const rec = n.record as Record<string, unknown>;
    const prov = rec.provenance as { excerpt?: string } | undefined;
    return {
      id: n.id,
      type: nodeTypeOf(n.collection),
      text: String(rec.text ?? ""),
      description: typeof rec.description === "string" ? rec.description : undefined,
      epistemicStatus: typeof rec.epistemicStatus === "string" ? rec.epistemicStatus : undefined,
      sourceType: typeof rec.sourceType === "string" ? rec.sourceType : undefined,
      doi: typeof rec.doi === "string" ? rec.doi : undefined,
      url: typeof rec.url === "string" ? rec.url : undefined,
      anchor: prov?.excerpt,
    };
  });
  let seq = 0;
  const mk = (e: Edge): StageEdge => ({ id: `x${seq++}`, relation: e.relation, subject: e.subject, object: e.object, anchor: e.anchor });
  const edges: StageEdge[] = [
    ...r.built.edges.map(mk),
    ...r.built.dangling.map(mk),
    ...r.built.ungrammatical.map((u) => mk(u.edge)),
  ];
  return {
    nodes,
    edges,
    paper: r.paper,
    meta: {
      source: r.source,
      model: r.model,
      truncated: r.truncated,
      chunks: r.chunks ?? 1,
      fullChars: r.fullChars,
      extractedText: r.extractedText ?? "",
    },
    seq: seq + 1,
  };
}

export interface Validation {
  nodeNeedsText: Set<string>;
  edgeStatus: Map<string, { valid: boolean; reason?: string }>;
  publishable: boolean;
  liveNodeCount: number;
  liveEdgeCount: number; // valid, non-dropped
}

/** Re-derive what's broken. Pure — depends only on the model. */
export function validate(m: StageModel): Validation {
  const live = new Map<string, StageNode>();
  for (const n of m.nodes) if (!n.dropped) live.set(n.id, n);

  const nodeNeedsText = new Set<string>();
  for (const n of live.values()) if (!n.text.trim()) nodeNeedsText.add(n.id);

  const edgeStatus = new Map<string, { valid: boolean; reason?: string }>();
  let liveEdgeCount = 0;
  for (const e of m.edges) {
    if (e.dropped) continue;
    const s = live.get(e.subject);
    const o = live.get(e.object);
    let valid = true;
    let reason: string | undefined;
    if (!s || !o) {
      valid = false;
      reason = !s && !o ? "both endpoints are missing/dropped" : !s ? "subject is missing/dropped" : "object is missing/dropped";
    } else {
      const g = EDGE_GRAMMAR[e.relation];
      if (!g) {
        valid = false;
        reason = `unknown relation "${e.relation}"`;
      } else if (!g.subj.includes(s.type) || !g.obj.includes(o.type)) {
        valid = false;
        reason = `${e.relation} wants ${g.subj.join("|")}→${g.obj.join("|")}, got ${s.type}→${o.type}`;
      }
    }
    edgeStatus.set(e.id, { valid, reason });
    if (valid) liveEdgeCount++;
  }

  return {
    nodeNeedsText,
    edgeStatus,
    publishable: live.size > 0 && nodeNeedsText.size === 0,
    liveNodeCount: live.size,
    liveEdgeCount,
  };
}

/** Relations whose grammar allows this exact directed (subject → object) pair. */
export function legalRelationsForPair(subj: NodeType, obj: NodeType): string[] {
  return RELATIONS.filter((r) => EDGE_GRAMMAR[r].subj.includes(subj) && EDGE_GRAMMAR[r].obj.includes(obj));
}

// ids the NEXT addNode/addEdge will mint — lets a caller select the new item after applying.
export const peekNodeId = (m: StageModel) => `n${m.seq}`;
export const peekEdgeId = (m: StageModel) => `e${m.seq}`;

const clone = (m: StageModel): StageModel => ({ ...m, nodes: [...m.nodes], edges: [...m.edges] });

export const ops = {
  editNode(m: StageModel, id: string, patch: Partial<StageNode>): StageModel {
    const out = clone(m);
    out.nodes = out.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    return out;
  },
  addNode(m: StageModel, type: NodeType, fields: Partial<StageNode> = {}): StageModel {
    const out = clone(m);
    out.nodes = [...out.nodes, { id: `n${out.seq}`, type, text: "", ...fields, added: true, dropped: false }];
    out.seq = out.seq + 1;
    return out;
  },
  dropNode(m: StageModel, id: string): StageModel {
    return this.editNode(m, id, { dropped: true });
  },
  restoreNode(m: StageModel, id: string): StageModel {
    return this.editNode(m, id, { dropped: false });
  },
  editEdge(m: StageModel, id: string, patch: Partial<StageEdge>): StageModel {
    const out = clone(m);
    out.edges = out.edges.map((e) => (e.id === id ? { ...e, ...patch } : e));
    return out;
  },
  addEdge(m: StageModel, relation: string, subject: string, object: string): StageModel {
    const out = clone(m);
    out.edges = [...out.edges, { id: `e${out.seq}`, relation, subject, object, added: true, dropped: false }];
    out.seq = out.seq + 1;
    return out;
  },
  dropEdge(m: StageModel, id: string): StageModel {
    return this.editEdge(m, id, { dropped: true });
  },
  restoreEdge(m: StageModel, id: string): StageModel {
    return this.editEdge(m, id, { dropped: false });
  },
  editPaper(m: StageModel, patch: Partial<StagePaper>): StageModel {
    return { ...m, paper: { ...(m.paper ?? {}), ...patch } };
  },
};

function slugify(source: string): string {
  return source.replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "paper";
}

/**
 * Export the EDITED graph in the library's record shape (mirrors src/grammar.ts buildGraph):
 * only kept, non-empty nodes and only kept, VALID edges. User-authored nodes are marked
 * `wasGeneratedBy: "humanAuthored"` so the provenance stays honest.
 */
export function exportGraph(m: StageModel, v: Validation, createdAt: string) {
  const slug = slugify(m.meta.source);
  const nodes = m.nodes
    .filter((n) => !n.dropped && n.text.trim())
    .map((n) => {
      const collection = TYPE_TO_COLLECTION[n.type];
      const provenance: Record<string, unknown> = {
        wasGeneratedBy: n.added ? "humanAuthored" : "aiAssistedExtraction",
        wasAttributedTo: "did:plc:PLACEHOLDER",
      };
      if (n.anchor && n.anchor.trim()) provenance.excerpt = n.anchor.trim();
      const record: Record<string, unknown> = { $type: collection, text: n.text.trim() };
      if (n.type === "source") {
        if (n.sourceType) record.sourceType = n.sourceType;
        if (n.doi) record.doi = n.doi;
        if (n.url) record.url = n.url;
      }
      if (n.description && n.description.trim()) record.description = n.description.trim();
      if (n.type === "claim") record.epistemicStatus = n.epistemicStatus || "claim";
      record.tags = [slug, n.id];
      record.provenance = provenance;
      record.createdAt = createdAt;
      return { id: n.id, collection, record };
    });
  const edges = m.edges
    .filter((e) => !e.dropped && v.edgeStatus.get(e.id)?.valid)
    .map((e) => ({ relation: e.relation, subject: e.subject, object: e.object, ...(e.anchor ? { anchor: e.anchor } : {}) }));
  return { source: m.meta.source, model: m.meta.model, edited: true, paper: m.paper, nodes, edges };
}
