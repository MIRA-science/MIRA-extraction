/**
 * to-mira-jsonld.ts — serialize a classified extraction into CANONICAL MIRA
 * JSON-LD, in the shape of the schema repo's own sampleData.json.
 *
 * Canonical target: github.com/MIRA-science/schema — mira.yaml (LinkML source
 * of truth), mira.jsonld (the published @context this document references),
 * mira.shacl (the closed node shapes CI validates against).
 *
 * Shape notes, all mirroring community practice:
 *   - Node types are emitted as [local NodeSchema def, MIRA class] — the
 *     sample-data pattern for tool-local subtypes.
 *   - Relations are REIFIED as RelationInstances (dgb:source/dgb:destination,
 *     rdf:predicate) — required, not stylistic: MIRA's Argument mixin is
 *     assigned to no class, so a supports/opposes property directly on a node
 *     would fail the closed SHACL shapes; a reified statement touches none of
 *     them.
 *   - Anchors (verbatim grounding quotes) use the schema's own grounding
 *     convention: each quote is an Item in the paper's document Container
 *     (sioc:has_container — the containment slot the closed Item shape
 *     carries), and the grounded node's `description` points at it.
 *   - Evidence carries mira:sourceDocument DIRECTLY (it is in Evidence's
 *     closed shape): derived along the spine when the evidence's study is
 *     described by a source, else stamped with the paper's own source document
 *     when identifiable, else omitted and counted.
 *   - A SourceDocument with a DOI gets a doi.org IRI as its @id (a URL gets
 *     the URL); everything else gets a local id under the run's base IRI.
 *   - The paper's printed authors become UserAccounts (ORCID iri when printed)
 *     and the paper document's dct:creator — attribution lands in-schema. The
 *     paper's license has no MIRA slot and is reported, never silently lost.
 *
 * Developed by SciOS; the projection approach is ported upstream from RRGI's
 * mira-export.js, rebuilt here for the current schema (2026-08). Pure module.
 */

import type { CleanEdge, CleanNode, NodeClass, PaperInfo } from "./grammar.ts";

const PURL_CONTEXT = "https://purl.org/mira-science/mira.jsonld";

export interface MiraJsonldOptions {
  /** Short name for this run — becomes part of the local IRI base. */
  slug?: string;
  /** Base IRI for minted ids (default `urn:mira-extraction:<slug>:`). */
  baseIri?: string;
  /** ISO timestamp stamped as created/modified on every emitted object. */
  generatedAt?: string;
  /** accountName of the extracting agent (the record creator, not the paper's authors). */
  creatorName?: string;
  /** Replace the PURL context reference with an inline context object —
   *  for OFFLINE validation (e.g. pyshacl against the vendored mira.shacl,
   *  where fetching https://purl.org/… is unwanted). Default: the PURL. */
  contextOverride?: unknown;
}

export interface MiraJsonldReport {
  nodes: { total: number; mapped: number; byClass: Record<string, number> };
  edges: { total: number; mapped: number; byPredicate: Record<string, number>; dropped: number };
  anchors: { nodesWithAnchor: number; edgesWithAnchor: number };
  sourceDocumentStamps: { derivedFromSpine: number; paperFallback: number; unstamped: number };
  omitted: string[];
  notes: string[];
}

function slugify(s: string): string {
  return (
    String(s || "extraction")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "extraction"
  );
}

function truncate(s: string, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function normTitle(s: string): string {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sourceIri(n: CleanNode, fallback: string): string {
  const doi = (n.doi || "").trim();
  if (doi) return /^https?:\/\//i.test(doi) ? doi : "https://doi.org/" + doi.replace(/^doi:/i, "");
  const url = (n.url || "").trim();
  if (url && /^https?:\/\//i.test(url)) return url;
  return fallback;
}

/**
 * input: the classified (and merged/consolidated) graph plus the extraction-time
 * paper attribution. Returns { jsonld, report }.
 */
export function toMiraJsonld(
  input: { nodes: CleanNode[]; edges: CleanEdge[]; paper: PaperInfo | null },
  options: MiraJsonldOptions = {},
): { jsonld: Record<string, unknown>; report: MiraJsonldReport } {
  const { nodes, edges, paper } = input;
  const slug = slugify(options.slug || paper?.title || "extraction");
  const base = options.baseIri || `urn:mira-extraction:${slug}:`;
  const now = options.generatedAt || new Date().toISOString();

  const report: MiraJsonldReport = {
    nodes: { total: nodes.length, mapped: 0, byClass: {} },
    edges: { total: edges.length, mapped: 0, byPredicate: {}, dropped: 0 },
    anchors: { nodesWithAnchor: 0, edgesWithAnchor: 0 },
    sourceDocumentStamps: { derivedFromSpine: 0, paperFallback: 0, unstamped: 0 },
    omitted: [],
    notes: [],
  };

  // ---- context: the published PURL context + this run's local prefix --------
  const context = [options.contextOverride ?? PURL_CONTEXT, { x: base }];

  // ---- the extracting agent -------------------------------------------------
  const extractorId = "x:agent";
  const accounts: Record<string, unknown>[] = [
    { "@id": extractorId, "@type": "UserAccount", accountName: truncate(options.creatorName || "MIRA-extraction", 256) },
  ];

  // The paper's printed authors → UserAccounts (ORCID IRI when printed).
  const authorIds: string[] = [];
  (paper?.authors || []).forEach((a, i) => {
    const id = a.orcid ? `https://orcid.org/${a.orcid}` : `x:author-${i}`;
    authorIds.push(id);
    accounts.push({ "@id": id, "@type": "UserAccount", accountName: truncate(a.name, 256) });
  });

  // ---- node ids -------------------------------------------------------------
  const idByKey = new Map<string, string>(); // CleanNode.id -> @id
  const typeByKey = new Map<string, NodeClass>();
  nodes.forEach((n, i) => {
    const local = `x:n${i}`;
    idByKey.set(n.id, n.type === "SourceDocument" ? sourceIri(n, local) : local);
    typeByKey.set(n.id, n.type);
  });

  // The paper's own SourceDocument node, when identifiable: DOI match first,
  // then exact (normalized) title match. Used for the sourceDocument fallback
  // stamp and as the paper the anchors' document Item stands for.
  const paperDoi = (paper?.doi || "").trim().toLowerCase();
  const paperTitle = normTitle(paper?.title || "");
  let paperSourceKey: string | null = null;
  for (const n of nodes) {
    if (n.type !== "SourceDocument") continue;
    if (paperDoi && (n.doi || "").trim().toLowerCase() === paperDoi) { paperSourceKey = n.id; break; }
    if (!paperSourceKey && paperTitle && normTitle(n.text) === paperTitle) paperSourceKey = n.id;
  }

  // ---- the spine walk for evidence → sourceDocument -------------------------
  // grounds: study → evidence; describesActivity: source → study.
  const studyOfEvidence = new Map<string, string>();
  const sourceOfStudy = new Map<string, string>();
  for (const e of edges) {
    if (e.relation === "grounds" && !studyOfEvidence.has(e.object)) studyOfEvidence.set(e.object, e.subject);
    if (e.relation === "describesActivity" && !sourceOfStudy.has(e.object)) sourceOfStudy.set(e.object, e.subject);
  }

  // ---- the document Item + anchor Items (the grounding convention) ----------
  const docId = "x:doc";
  const items: Record<string, unknown>[] = [];
  let anyAnchor = false;

  // ---- node schema defs (one per used class, sample-data pattern) -----------
  const usedClasses = new Set<NodeClass>();

  // ---- node objects ---------------------------------------------------------
  const nodeObjs: Record<string, unknown>[] = [];
  nodes.forEach((n, i) => {
    const id = idByKey.get(n.id)!;
    usedClasses.add(n.type);
    report.nodes.mapped++;
    report.nodes.byClass[n.type] = (report.nodes.byClass[n.type] || 0) + 1;

    const isPaperDoc = n.id === paperSourceKey;
    const obj: Record<string, unknown> = {
      "@id": id,
      "@type": [`x:_schema_${n.type}`, n.type],
      title: truncate(n.text, 200),
      content: n.description ? `${n.text}\n\n${n.description}` : n.text,
      created: now,
      modified: now,
      // The record's creator is the extracting agent; the paper document's
      // creators are its printed authors (in-schema attribution capture).
      creator: isPaperDoc && authorIds.length ? authorIds : extractorId,
    };

    if (n.anchor) {
      report.anchors.nodesWithAnchor++;
      anyAnchor = true;
      const anchorId = `x:a-n${i}`;
      items.push({
        "@id": anchorId,
        "@type": "Item",
        format: "text/plain",
        content: n.anchor,
        has_container: docId,
      });
      obj.description = anchorId;
    }

    if (n.type === "Evidence") {
      const viaStudy = studyOfEvidence.get(n.id);
      const viaSource = viaStudy ? sourceOfStudy.get(viaStudy) : undefined;
      if (viaSource) {
        obj.sourceDocument = idByKey.get(viaSource);
        report.sourceDocumentStamps.derivedFromSpine++;
      } else if (paperSourceKey) {
        obj.sourceDocument = idByKey.get(paperSourceKey);
        report.sourceDocumentStamps.paperFallback++;
      } else {
        report.sourceDocumentStamps.unstamped++;
      }
    }

    nodeObjs.push(obj);
  });

  const schemaDefs: Record<string, unknown>[] = [...usedClasses].map((cls) => ({
    "@id": `x:_schema_${cls}`,
    "@type": "NodeSchema",
    subClassOf: [cls],
    label: cls,
    created: now,
    modified: now,
    creator: extractorId,
  }));

  // ---- reified relations ----------------------------------------------------
  const textByKey = new Map(nodes.map((n) => [n.id, n.text]));
  const usedRels = new Set<string>();
  const relObjs: Record<string, unknown>[] = [];
  let reli = 0;
  for (const e of edges) {
    const src = idByKey.get(e.subject);
    const dst = idByKey.get(e.object);
    if (!src || !dst) { report.edges.dropped++; continue; } // defensive — classify guarantees resolution
    usedRels.add(e.relation);
    // Typed [local def, the MIRA slot term, RelationInstance] — the sample-data
    // pattern. The slot term as a type IS the predicate (punning the community
    // uses); an explicit rdf:predicate triple would trip the generated
    // Statement shape (its value would need an rdfs:Resource typing).
    const obj: Record<string, unknown> = {
      "@id": `x:r${reli}`,
      "@type": [`x:_rel_${e.relation}`, e.relation, "RelationInstance"],
      source: src,
      destination: dst,
      title: `${truncate(textByKey.get(e.subject) || e.subject, 80)} -${e.relation}-> ${truncate(textByKey.get(e.object) || e.object, 80)}`,
      created: now,
      modified: now,
      creator: extractorId,
    };
    if (e.anchor) {
      report.anchors.edgesWithAnchor++;
      anyAnchor = true;
      const anchorId = `x:a-r${reli}`;
      items.push({ "@id": anchorId, "@type": "Item", format: "text/plain", content: e.anchor, has_container: docId });
      obj.description = anchorId;
    }
    reli++;
    report.edges.mapped++;
    report.edges.byPredicate[e.relation] = (report.edges.byPredicate[e.relation] || 0) + 1;
    relObjs.push(obj);
  }

  const relDefs: Record<string, unknown>[] = [...usedRels].map((rel) => ({
    "@id": `x:_rel_${rel}`,
    "@type": "AbstractRelationDef",
    subClassOf: [rel],
    label: rel,
    created: now,
    modified: now,
    creator: extractorId,
  }));

  // The paper's extracted-text container — present only when something anchors
  // to it. A sioc:Container ("an area in which content Items are contained"):
  // the anchor Items point at it via has_container, the slot the closed Item
  // shape carries.
  const docObjs: Record<string, unknown>[] = anyAnchor ? [{ "@id": docId, "@type": "Container" }] : [];

  // ---- assemble -------------------------------------------------------------
  const graph = [...accounts, ...schemaDefs, ...relDefs, ...docObjs, ...items, ...nodeObjs, ...relObjs];
  const jsonld: Record<string, unknown> = { "@context": context, "@graph": graph };

  if (paper?.license) {
    report.omitted.push("license");
    report.notes.push(`The paper's printed license ("${paper.license}") has no MIRA slot — carried in this report only.`);
  }
  if (!paperSourceKey && report.sourceDocumentStamps.unstamped)
    report.notes.push(
      "The paper's own SourceDocument node could not be identified (no DOI/title match), so evidence without a study chain carries no sourceDocument stamp.",
    );

  return { jsonld, report };
}
