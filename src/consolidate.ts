/**
 * consolidate.ts — the CONSOLIDATION PASS: one model call over the whole
 * paper's record LIST, closing per-piece reading's TWO blind spots.
 *
 * A paper read in pieces (a) can extract the same statement twice from two
 * pieces — a duplicate that would masquerade as two independent records — and
 * (b) can never propose a relation between records from different pieces,
 * because no single read saw them together. This pass sends the merged record
 * list (a few KB regardless of paper length) to the model once and asks for
 * both: same-proposition MERGE GROUPS, and MISSING RELATIONS across the whole
 * set. This matches the RRGI deployment's live behavior (its upload door
 * applies both halves).
 *
 * Everything the model proposes is RE-CHECKED here; nothing is trusted raw:
 *   - a merge group is applied only when every id resolves, all members share
 *     ONE type, that type is mergeable (Claim/Question/Evidence — never
 *     SourceDocument/Study/Protocol/Request), and no id was already claimed by
 *     an earlier group; the survivor is the earliest node in graph order,
 *     keeping the longest description and first anchor;
 *   - a proposed edge is re-pointed through the fold map, then must be
 *     grammar-legal, non-self-loop, and not a duplicate of an existing edge;
 *     applied edges are marked `consolidated: true` so reviewers can see they
 *     were cross-piece proposals.
 *
 * Ported upstream by SciOS from the RRGI deployment's consolidation
 * (consolidate-graph.mjs + chunk-merge.js applyConsolidation), community
 * grammar. Last synced: 2026-08-10.
 */

import { EDGE_GRAMMAR, type CleanEdge, type CleanNode } from "./grammar.ts";

/** The types eligible for model-judged merging: only the semantic trio, whose
 *  piece-boundary duplicates would masquerade as corroboration. Source
 *  documents dedup by identifier at projection; studies, protocols, and
 *  requests never model-merge. */
export const MERGEABLE_TYPES = new Set(["Claim", "Question", "Evidence"]);

/** Above this many records, skip consolidation (recorded, never silent) —
 *  the RRGI endpoint's own cap. */
export const CONSOLIDATE_MAX_NODES = 250;

const MAX_TEXT = 2000; // per-record text chars fed to the model (records are short)

export const CONSOLIDATE_SYSTEM_MESSAGE = `You consolidate the discourse records extracted from ONE research paper. The paper was
read in PIECES: each piece was decomposed into records independently, so the combined record set may (a) contain
DUPLICATES — the same statement extracted from two different pieces — and (b) be MISSING relations between
records that came from different pieces (no single read saw them together). You read the record list and return
ONLY a JSON object.

INPUT — a JSON object:
  "nodes": the paper's records — { "id", "type", "text", "description"? }. Types: Question, Claim, Evidence,
           Study, Protocol, SourceDocument, Request.
  "edges": the relations that ALREADY exist — { "relation", "subject", "object" }. Use them to see what is
           NOT missing; never re-propose one.

OUTPUT — return ONLY this JSON object, no prose, no code fences:
{
  "merges": [ ["g0", "g7"], ... ],
  "edges":  [ { "relation": "supports", "subject": "g4", "object": "g1" }, ... ]
}

MERGES — duplicate records to fold into one:
- Only "Claim", "Question", and "Evidence" records may merge — NEVER source documents, studies, protocols, or
  requests (source documents are deduplicated by identifier downstream; studies, protocols, and requests stay
  separate). A merge group lists ids of records of the SAME type that state THE SAME proposition — one is a
  restatement or duplicate of another, an artifact of reading the paper in pieces.
- THE SAME proposition means the same subject, the same direction, the same scope, the same quantities. An
  increase is not a decrease. A specific quantitative finding is not the general statement it illustrates. A
  result about one setting, population, or model variant is not a result about another. A hypothesis is not
  the evidence for it.
- When in doubt, do NOT merge — a wrong merge corrupts a record; a missed duplicate is recoverable later.
- List each id in at most ONE group. Return "merges": [] when nothing should fold.

EDGE TYPES (relation, then the only legal endpoint types — obey these exactly):
- "addresses":         subject=Claim              → object=Question  (a claim answers a research question)
- "supports":          subject=Evidence or Claim  → object=Claim     (the subject strengthens the claim)
- "opposes":           subject=Evidence or Claim  → object=Claim     (the subject weakens the claim)
- "describesActivity": subject=SourceDocument     → object=Study     (a document describes the study it reports)
- "grounds":           subject=Study              → object=Evidence  (a study produces/grounds a piece of evidence)
- "follows":           subject=Study              → object=Protocol  (a study follows a method — one edge per protocol)
- "request_for":       subject=Request            → object=Study     (the proposed study the request calls for)
- "request_target":    subject=Request            → object=Claim     (a claim the requested work concerns)

EDGES — relations the per-piece reads could not see:
- Propose ONLY relations that the records' own texts clearly state or entail: evidence whose text plainly
  reports on exactly what a claim asserts (supports/opposes); a claim whose text argues from another claim's
  finding (supports/opposes); a study and the evidence its text says it produced (grounds); a study and the
  method its text says it used (follows); a document and the study it reports (describesActivity); a request
  and the claim or proposed study its text names (request_target / request_for).
- Do NOT re-propose a relation already in the input edges list.
- NEVER invent a relationship the texts do not state. Prefer fewer, certain relations. Return "edges": []
  when nothing is missing.`;

/** Build the user message: the whole record list + the existing relations. */
export function consolidateUserMessage(nodes: CleanNode[], edges: CleanEdge[]): string {
  const ns = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    text: n.text.slice(0, MAX_TEXT),
    ...(n.description ? { description: n.description.slice(0, MAX_TEXT) } : {}),
  }));
  const es = edges.map((e) => ({ relation: e.relation, subject: e.subject, object: e.object }));
  return "Consolidate this paper's records. Return ONLY the JSON object.\n\n" + JSON.stringify({ nodes: ns, edges: es });
}

export interface ConsolidationVerdict {
  merges: string[][];
  edges: { relation: string; subject: string; object: string }[];
}

/** Parse the model's reply into { merges, edges } — tolerant of fences/prose.
 *  Null on total failure. Either array may be missing (treated as empty). */
export function parseVerdict(content: string): ConsolidationVerdict | null {
  let t = content.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  const tryParse = (s: string): ConsolidationVerdict | null => {
    try {
      const g = JSON.parse(s);
      if (g && typeof g === "object" && !Array.isArray(g) && (Array.isArray(g.merges) || Array.isArray(g.edges))) {
        return {
          merges: Array.isArray(g.merges) ? g.merges : [],
          edges: Array.isArray(g.edges) ? g.edges : [],
        };
      }
    } catch { /* fall through */ }
    return null;
  };
  let v = tryParse(t);
  if (!v) v = tryParse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  return v;
}

export interface ConsolidateStats {
  groupsApplied: number;
  groupsRejected: number;
  recordsFolded: number;
  edgesAdded: number;
  proposedRejected: number;
  edgesDroppedByFold: number;
  skipped?: string; // set when the pass didn't run (with the reason)
}

export interface ConsolidatedGraph {
  nodes: CleanNode[];
  edges: CleanEdge[];
  stats: ConsolidateStats;
}

/** Apply a consolidation verdict — merges AND proposed edges — to a merged
 *  { nodes, edges } graph. Pure; everything re-checked (see file header). */
export function applyConsolidation(
  graph: { nodes: CleanNode[]; edges: CleanEdge[] },
  verdict: ConsolidationVerdict,
): ConsolidatedGraph {
  const order = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // ---- merges: validate groups, build the fold map --------------------------
  const foldInto = new Map<string, string>(); // foldedId -> survivorId
  const claimed = new Set<string>();
  let groupsApplied = 0;
  let groupsRejected = 0;
  let recordsFolded = 0;

  for (const raw of Array.isArray(verdict.merges) ? verdict.merges : []) {
    const ids = Array.isArray(raw) ? [...new Set(raw.map((x) => String(x)))] : [];
    const members = ids.map((id) => byId.get(id));
    const ok =
      ids.length >= 2 &&
      members.every(Boolean) &&
      new Set(members.map((n) => n!.type)).size === 1 &&
      MERGEABLE_TYPES.has(members[0]!.type) &&
      ids.every((id) => !claimed.has(id));
    if (!ok) { groupsRejected++; continue; }
    ids.sort((a, b) => order.get(a)! - order.get(b)!);
    const surv = byId.get(ids[0])!;
    for (const id of ids) claimed.add(id);
    for (const id of ids.slice(1)) {
      const n = byId.get(id)!;
      if ((n.description || "").length > (surv.description || "").length) surv.description = n.description;
      if (!surv.anchor && n.anchor) surv.anchor = n.anchor;
      foldInto.set(id, surv.id);
      recordsFolded++;
    }
    groupsApplied++;
  }
  const resolve = (id: string) => foldInto.get(id) ?? id;

  const nodes = graph.nodes.filter((n) => !foldInto.has(n.id));
  const survById = new Map(nodes.map((n) => [n.id, n]));

  // ---- existing edges re-pointed through the fold map -----------------------
  const edges: CleanEdge[] = [];
  const seen = new Set<string>();
  let edgesDroppedByFold = 0;
  const edgeKey = (r: string, s: string, o: string) => `${r} ${s} ${o}`;
  for (const e of graph.edges) {
    const s = resolve(e.subject);
    const o = resolve(e.object);
    const key = edgeKey(e.relation, s, o);
    if (s === o || seen.has(key)) { edgesDroppedByFold++; continue; }
    seen.add(key);
    const edge: CleanEdge = { relation: e.relation, subject: s, object: o };
    if (e.anchor) edge.anchor = e.anchor;
    if (e.consolidated) edge.consolidated = true;
    edges.push(edge);
  }

  // ---- proposed edges: re-point, grammar-check, dedup -----------------------
  let edgesAdded = 0;
  let proposedRejected = 0;
  for (const e of Array.isArray(verdict.edges) ? verdict.edges : []) {
    const relation = String(e?.relation ?? "");
    const s = resolve(String(e?.subject ?? ""));
    const o = resolve(String(e?.object ?? ""));
    const sn = survById.get(s);
    const on = survById.get(o);
    const gram = EDGE_GRAMMAR[relation];
    const legal = !!sn && !!on && s !== o && !!gram && gram.subj.includes(sn.type) && gram.obj.includes(on.type);
    if (!legal || seen.has(edgeKey(relation, s, o))) { proposedRejected++; continue; }
    seen.add(edgeKey(relation, s, o));
    edges.push({ relation, subject: s, object: o, consolidated: true });
    edgesAdded++;
  }

  return {
    nodes,
    edges,
    stats: { groupsApplied, groupsRejected, recordsFolded, edgesAdded, proposedRejected, edgesDroppedByFold },
  };
}
