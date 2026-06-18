/**
 * The MIRA-graph grammar + the pure transform from the model's raw graph into
 * RRGI-shaped records with a legal / dangling / ungrammatical edge split.
 *
 * Pure functions only — NO network, NO ATProto, NO IPFS, NO file I/O. This is the
 * heart of the extractor: it defines the five node types, the five relation types
 * and their legal endpoints, and turns the model's loosely-typed `{nodes,edges}`
 * into concrete records while reporting (never silently dropping) any edge that
 * dangles or violates the grammar.
 *
 *   nodes:  question · claim · evidence · source · study
 *   edges:  addresses  claim          → question   (a claim answers a question)
 *           supports   evidence|claim → claim      (strengthens a claim)
 *           opposes    evidence|claim → claim      (weakens a claim)
 *           describes  source         → study      (a source describes the study it reports)
 *           grounds    study          → evidence   (a study grounds a piece of evidence)
 *
 * The canonical provenance spine is  source --describes--> study --grounds--> evidence,
 * mirroring MIRA's describesActivity + grounds. The old single-hop source--informs-->
 * evidence is RETIRED here: new graphs never emit it (the study node is inserted between
 * the source and the evidence it grounds).
 */

// node type → the record collection ($type). These names are RRGI's lexicon NSIDs;
// the records are shaped so they can later be fed into an RRGI/AT-Protocol system,
// but producing them needs nothing from ATProto — they are plain JSON objects.
export const TYPE_TO_COLLECTION: Record<string, string> = {
  question: "tech.scios.rrgi.question",
  claim: "tech.scios.rrgi.claim",
  evidence: "tech.scios.rrgi.evidence",
  source: "tech.scios.rrgi.source",
  study: "tech.scios.rrgi.study",
};

// relation → the only legal { subject types, object types }. Used both in the prompt
// (so the model emits legal edges) and here (so we catch and report illegal ones).
// The provenance spine is source --describes--> study --grounds--> evidence; the old
// single-hop `informs` (source→evidence) is intentionally absent — new graphs never emit it,
// and an `informs` edge from the model is now reported as ungrammatical (unknown relation).
export const EDGE_GRAMMAR: Record<string, { subj: string[]; obj: string[] }> = {
  addresses: { subj: ["claim"], obj: ["question"] },
  supports: { subj: ["evidence", "claim"], obj: ["claim"] },
  opposes: { subj: ["evidence", "claim"], obj: ["claim"] },
  describes: { subj: ["source"], obj: ["study"] },
  grounds: { subj: ["study"], obj: ["evidence"] },
};

// ---- types: the model's proposed graph (temp local ids) -------------------
export interface RawNode {
  id: string;
  type: string;
  text: string;
  description?: string;
  epistemicStatus?: string; // claim-only
  sourceType?: string; // source-only
  doi?: string; // source-only
  url?: string; // source-only
  /** a short VERBATIM quote from the spot in the paper that grounds this record
   *  (becomes provenance.excerpt — the record's grounding in the source's words). */
  anchor?: string;
}
export interface RawEdge {
  relation: string;
  subject: string; // temp id
  object: string; // temp id
  anchor?: string; // present only when a single passage states the relationship
}
export interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
  paper?: unknown; // model-reported attribution for the paper itself (cleaned separately)
}

/** Extraction-time attribution for the paper itself — groundable-in-the-text only. */
export interface PaperInfo {
  title?: string;
  doi?: string;
  license?: string;
  authors?: { name: string; orcid?: string }[];
}

// ---- types: the built (record-shaped) graph -------------------------------
export interface BuiltNode {
  id: string; // the model's temp id (q1/c2/…), kept for edge resolution + tags
  collection: string; // the record $type
  record: Record<string, unknown>;
}
export interface BuiltGraph {
  nodes: BuiltNode[];
  edges: RawEdge[]; // legal + both endpoints resolve
  dangling: RawEdge[]; // an endpoint id doesn't exist
  ungrammatical: { edge: RawEdge; why: string }[]; // endpoints exist but violate the grammar
}

/**
 * Clean an ANCHOR QUOTE — the model's short verbatim passage grounding a node/edge.
 * Strings only; control chars collapse to spaces; wrapping quote marks are stripped
 * (models often add them — the INNER text is what must locate in the paper); capped
 * at 256 chars. Garbage/empty → "" (no anchor — best-effort, never blocks).
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
 * Turn the raw graph into records + a grammar-checked edge classification. Pure.
 * `attributedTo` is stamped into provenance.wasAttributedTo (a placeholder DID is
 * fine — this tool signs nothing); `slug` tags every record so a paper's records
 * are findable as a set.
 */
export function buildGraph(raw: RawGraph, attributedTo: string, slug: string): BuiltGraph {
  const idToType = new Map<string, string>();
  const nodes: BuiltNode[] = [];
  const createdAt = new Date().toISOString();
  const provenance = { wasGeneratedBy: "aiAssistedExtraction", wasAttributedTo: attributedTo };

  for (const n of raw.nodes || []) {
    const collection = TYPE_TO_COLLECTION[n.type];
    if (!collection || !n.id || !n.text) continue; // skip malformed nodes
    idToType.set(n.id, n.type);
    const tags = [slug, n.id];
    // the anchor quote persists ON the record as provenance.excerpt — the record's
    // grounding in the source's own words (checkable against any copy of the paper).
    const anchor = cleanAnchor(n.anchor);
    const prov = anchor ? { ...provenance, excerpt: anchor } : provenance;
    let record: Record<string, unknown>;
    if (n.type === "source") {
      record = {
        $type: collection,
        text: n.text,
        ...(n.sourceType ? { sourceType: n.sourceType } : {}),
        ...(n.doi ? { doi: n.doi } : {}),
        ...(n.url ? { url: n.url } : {}),
        ...(n.description ? { description: n.description } : {}),
        tags,
        provenance: prov,
        createdAt,
      };
    } else {
      record = {
        $type: collection,
        text: n.text,
        ...(n.description ? { description: n.description } : {}),
        ...(n.type === "claim" ? { epistemicStatus: n.epistemicStatus || "claim" } : {}),
        tags,
        provenance: prov,
        createdAt,
      };
    }
    nodes.push({ id: n.id, collection, record });
  }

  const edges: RawEdge[] = [];
  const dangling: RawEdge[] = [];
  const ungrammatical: { edge: RawEdge; why: string }[] = [];
  const seen = new Set<string>();
  for (const e of raw.edges || []) {
    const key = `${e.relation}|${e.subject}|${e.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gram = EDGE_GRAMMAR[e.relation];
    if (!gram) { ungrammatical.push({ edge: e, why: `unknown relation "${e.relation}"` }); continue; }
    const st = idToType.get(e.subject);
    const ot = idToType.get(e.object);
    if (!st || !ot) { dangling.push(e); continue; }
    if (!gram.subj.includes(st) || !gram.obj.includes(ot)) {
      ungrammatical.push({ edge: e, why: `${e.relation} wants ${gram.subj.join("|")}→${gram.obj.join("|")}, got ${st}→${ot}` });
      continue;
    }
    const anchor = cleanAnchor(e.anchor);
    edges.push(anchor ? { ...e, anchor } : { relation: e.relation, subject: e.subject, object: e.object });
  }
  return { nodes, edges, dangling, ungrammatical };
}
