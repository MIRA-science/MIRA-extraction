/**
 * grammar.ts — the MIRA extraction grammar: the node classes, the legal
 * relations, and the pure classification pass that turns a model's raw
 * {nodes, edges} reply into a clean graph with every rejection reported.
 *
 * VOCABULARY = THE SCHEMA'S OWN. Node types are MIRA class names (mira.yaml:
 * Question, Claim, Evidence, Study, Protocol, SourceDocument, Request) and
 * relations are MIRA slot names (addresses, supports, opposes,
 * describesActivity, grounds, follows, request_for, request_target). There is
 * no internal-to-MIRA translation table anywhere in this tool: what the model
 * emits is what the JSON-LD says.
 *
 * WHO MAY ARGUE — the one interpretation this tool takes of an open schema
 * point. MIRA's Argument mixin ("a node that can support or oppose another
 * node") is assigned to no class, so the schema does not name which nodes may
 * argue. This extractor accepts BOTH a Claim and Evidence as the subject of
 * supports/opposes (the object is always a Claim, matching the slots' range) —
 * consistent with the schema repo's own sampleData.json (which shows a claim
 * supporting a claim) while keeping the Evidence→Claim link the Evidence class
 * exists to provide. Because output relations are reified RelationInstances
 * (dgb:source / dgb:destination), no node ever carries a supports/opposes
 * property, so the closed SHACL node shapes are untouched by this
 * interpretation.
 *
 * Pure functions only — no network, no file I/O.
 *
 * LINEAGE: developed by SciOS; ported upstream from the extraction engine of
 * RRGI (https://graph.scios.tech), the production MIRA deployment this
 * machinery was field-tested in. Community variant (see src/prompt.ts for the
 * full divergence list). Last synced with the RRGI pipeline: 2026-08-10.
 */

// ---------------------------------------------------------------------------
// The palette and the grammar.
// ---------------------------------------------------------------------------

export const NODE_CLASSES = [
  "Question",
  "Claim",
  "Evidence",
  "Study",
  "Protocol",
  "SourceDocument",
  "Request",
] as const;
export type NodeClass = (typeof NODE_CLASSES)[number];

/** relation → the only legal { subject classes, object classes }. Used in the
 *  prompt (so the model emits legal edges) and here (so illegal ones are caught
 *  and reported, never silently dropped). */
export const EDGE_GRAMMAR: Record<string, { subj: NodeClass[]; obj: NodeClass[] }> = {
  addresses:         { subj: ["Claim"],             obj: ["Question"] },
  supports:          { subj: ["Evidence", "Claim"], obj: ["Claim"] },
  opposes:           { subj: ["Evidence", "Claim"], obj: ["Claim"] },
  describesActivity: { subj: ["SourceDocument"],    obj: ["Study"] },
  grounds:           { subj: ["Study"],             obj: ["Evidence"] },
  follows:           { subj: ["Study"],             obj: ["Protocol"] },
  request_for:       { subj: ["Request"],           obj: ["Study"] },
  request_target:    { subj: ["Request"],           obj: ["Claim"] },
};

// ---------------------------------------------------------------------------
// Types: the model's raw reply, and the classified graph.
// ---------------------------------------------------------------------------

export interface RawNode {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  description?: unknown;
  doi?: unknown; // SourceDocument only — becomes the node's IRI in the JSON-LD
  url?: unknown; // SourceDocument only — IRI fallback when there is no DOI
  /** a short VERBATIM quote from the spot in the paper that grounds this record. */
  anchor?: unknown;
}

export interface RawEdge {
  relation?: unknown;
  subject?: unknown;
  object?: unknown;
  anchor?: unknown; // present only when a single passage states the relationship
}

export interface RawGraph {
  nodes?: RawNode[];
  edges?: RawEdge[];
  paper?: unknown; // model-reported attribution for the paper itself (cleanPaper)
}

export interface CleanNode {
  id: string;
  type: NodeClass;
  text: string;
  description?: string;
  doi?: string;
  url?: string;
  anchor?: string;
}

export interface CleanEdge {
  relation: string;
  subject: string;
  object: string;
  anchor?: string;
  /** true when the consolidation pass proposed this edge (cross-piece) — kept
   *  on the edge so reviewers can see it wasn't stated by a single passage. */
  consolidated?: boolean;
}

export interface ClassifiedGraph {
  nodes: CleanNode[];
  edges: CleanEdge[];
  dropped: {
    nodes: { node: unknown; why: string }[];
    danglingEdges: { edge: CleanEdge; why: string }[];
    ungrammaticalEdges: { edge: CleanEdge; why: string }[];
  };
}

/** Extraction-time attribution for the paper itself — groundable-in-the-text only. */
export interface PaperInfo {
  title?: string;
  doi?: string;
  license?: string;
  authors?: { name: string; orcid?: string }[];
}

// ---------------------------------------------------------------------------
// Cleaning helpers.
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Clean an ANCHOR QUOTE — the model's short verbatim passage grounding a node
 * or edge. Strings only; control chars collapse to spaces; wrapping quote marks
 * are stripped (models often add them — the INNER text is what must locate in
 * the paper); capped at 256 chars (a sliced quote is still verbatim).
 * Garbage/empty → "" (no anchor — best-effort, never blocks).
 */
export function cleanAnchor(v: unknown): string {
  if (typeof v !== "string") return "";
  let t = v.replace(/\p{Cc}+/gu, " ").replace(/ {2,}/g, " ").trim();
  const QUOTES = "\"'‘’“”";
  while (t.length > 1 && QUOTES.includes(t[0]) && QUOTES.includes(t[t.length - 1]))
    t = t.slice(1, -1).trim();
  if (t.length > 256) t = t.slice(0, 256).trim();
  return t;
}

/**
 * Clean the model's optional "paper" attribution object — the extraction-time
 * capture of the paper's own title / authors / ORCIDs / DOI / license,
 * groundable-in-the-text only. Defensive: trim strings, drop empties, accept an
 * ORCID only in its canonical 0000-0000-0000-000X shape (a malformed one is
 * dropped, never "fixed" — a wrong ORCID is worse than none). Returns null when
 * nothing real survives, so callers can fall back to the filename.
 */
export function cleanPaper(raw: unknown): PaperInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: PaperInfo = {};
  const title = str(r.title);
  if (title) out.title = title.slice(0, 512);
  const doi = str(r.doi);
  if (doi) out.doi = doi.slice(0, 256);
  const license = str(r.license);
  if (license) out.license = license.slice(0, 256);
  const authors: { name: string; orcid?: string }[] = [];
  for (const a of Array.isArray(r.authors) ? r.authors : []) {
    const name = str((a as Record<string, unknown>)?.name);
    if (!name) continue;
    const author: { name: string; orcid?: string } = { name: name.slice(0, 256) };
    const orcid = str((a as Record<string, unknown>)?.orcid).replace(/^https?:\/\/(www\.)?orcid\.org\//i, "");
    if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) author.orcid = orcid.toUpperCase();
    authors.push(author);
    if (authors.length >= 64) break; // big-collaboration papers
  }
  if (authors.length) out.authors = authors;
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// The classification pass.
// ---------------------------------------------------------------------------

/**
 * Turn the model's raw graph into a clean, grammar-checked one. Pure.
 *
 * Nodes: a node with no id, no text, or an unknown type is dropped with a
 * reason; a reused id is dropped with a reason (the first occurrence wins).
 * doi/url survive only on SourceDocument nodes.
 *
 * Edges: exact duplicate (relation, subject, object) triples are folded;
 * an unknown relation or an endpoint-type violation is reported as
 * ungrammatical; an edge whose endpoint id doesn't resolve is reported as
 * dangling. Only clean, legal edges come back in `edges`.
 */
export function classifyGraph(raw: RawGraph): ClassifiedGraph {
  const idToType = new Map<string, NodeClass>();
  const nodes: CleanNode[] = [];
  const droppedNodes: { node: unknown; why: string }[] = [];

  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const id = str(n?.id);
    const type = str(n?.type) as NodeClass;
    const text = str(n?.text);
    if (!id || !text || !NODE_CLASSES.includes(type)) {
      droppedNodes.push({ node: n, why: !id ? "missing id" : !text ? "missing text" : `invalid type "${String(n?.type ?? "")}"` });
      continue;
    }
    if (idToType.has(id)) {
      droppedNodes.push({ node: n, why: `duplicate id "${id}"` });
      continue;
    }
    idToType.set(id, type);
    const clean: CleanNode = { id, type, text };
    const desc = str(n?.description);
    if (desc) clean.description = desc;
    const anchor = cleanAnchor(n?.anchor);
    if (anchor) clean.anchor = anchor;
    if (type === "SourceDocument") {
      const doi = str(n?.doi);
      const url = str(n?.url);
      if (doi) clean.doi = doi;
      if (url) clean.url = url;
    }
    nodes.push(clean);
  }

  const edges: CleanEdge[] = [];
  const danglingEdges: { edge: CleanEdge; why: string }[] = [];
  const ungrammaticalEdges: { edge: CleanEdge; why: string }[] = [];
  const seen = new Set<string>();

  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    const relation = str(e?.relation);
    const subject = str(e?.subject);
    const object = str(e?.object);
    const key = `${relation}|${subject}|${object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bare: CleanEdge = { relation, subject, object };
    const gram = EDGE_GRAMMAR[relation];
    if (!gram) {
      ungrammaticalEdges.push({ edge: bare, why: `unknown relation "${relation}"` });
      continue;
    }
    const st = idToType.get(subject);
    const ot = idToType.get(object);
    if (!st || !ot) {
      danglingEdges.push({ edge: bare, why: "endpoint id does not resolve" });
      continue;
    }
    if (!gram.subj.includes(st) || !gram.obj.includes(ot)) {
      ungrammaticalEdges.push({ edge: bare, why: `${relation} wants ${gram.subj.join("|")}→${gram.obj.join("|")}, got ${st}→${ot}` });
      continue;
    }
    const anchor = cleanAnchor(e?.anchor);
    edges.push(anchor ? { ...bare, anchor } : bare);
  }

  return { nodes, edges, dropped: { nodes: droppedNodes, danglingEdges, ungrammaticalEdges } };
}
