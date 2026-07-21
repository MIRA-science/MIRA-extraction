/**
 * to-mira-jsonld.ts — map the extractor's built graph to canonical MIRA JSON-LD.
 *
 * Canonical target: github.com/MIRA-science/schema (mira.yaml / mira.shacl / mira.jsonld)
 * and the demo graph github.com/MIRA-science/demo-MIRA-graph-data. Additive: it maps the
 * built node/edge model 1:1, invents nothing, and reports what it drops.
 *
 * Two hard facts about the target, encoded below:
 *   1. mira.jsonld mis-aliases "Study" to mira:Protocol; the context here overrides it to
 *      mira:Study (as the MIRA demo graph does).
 *   2. Every MIRA node shape is sh:closed to 8 metadata slots (created/modified/creator/
 *      title/description->Item/format/content/has_container). Fields with no closed-shape
 *      home (sourceType, doi, epistemicStatus, contextEntities) are dropped and reported,
 *      never silently discarded. All relations are reified as RelationInstance objects.
 *
 * The accurate, current RRGI system extends MIRA further (derivation, contradiction,
 * equivalence, endorsement, domains); those have no MIRA shape and never appear here.
 */

type Rec = Record<string, any>;
interface BuiltNode { id: string; collection: string; record: Rec }
interface BuiltEdge { relation: string; subject: string; object: string; anchor?: string }
interface Built { nodes: BuiltNode[]; edges: BuiltEdge[] }

export interface MiraExportReport {
  source: string | null;
  nodes: { total: number; mapped: number; byClass: Record<string, number>; droppedTypes: Record<string, number> };
  edges: { total: number; mapped: number; byPredicate: Record<string, number>; droppedTypes: Record<string, number>; droppedDangling: number };
  omittedFields: string[];
  notes: string[];
}
export interface MiraExportResult { jsonld: Rec; report: MiraExportReport }

const NS = "tech.scios.rrgi.";

const NODE_CLASS: Record<string, string> = {
  question: "Question",
  claim: "Claim",
  evidence: "Evidence",
  study: "Study",
  source: "SourceDocument",
  protocol: "Protocol",
};

// subject->source, object->destination. grounds stays study->evidence (no inversion);
// describes(source->study) becomes mira:describesActivity (CreativeWork->Activity).
const REL_PRED: Record<string, string> = {
  addresses: "addresses",
  supports: "supports",
  opposes: "opposes",
  grounds: "grounds",
  follows: "follows",
  describes: "describesActivity",
};

function miraContext(): Rec {
  return {
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    owl: "http://www.w3.org/2002/07/owl#",
    dct: "http://purl.org/dc/terms/",
    prov: "http://www.w3.org/ns/prov#",
    foaf: "http://xmlns.com/foaf/0.1/",
    sioc: "http://rdfs.org/sioc/ns#",
    dgc: "https://discoursegraphs.com/schema/dg_core#",
    dgb: "https://discoursegraphs.com/schema/dg_base#",
    mira: "http://purl.org/mira-science/mira#",
    rrgi: "https://rrgi.scios.tech/id/",
    agent: "https://rrgi.scios.tech/agent/",
    rel: "http://purl.org/mira-science/mira/rel#",
    reli: "http://purl.org/mira-science/mira/reli#",
    predicate: { "@id": "rdf:predicate", "@type": "@id" },
    subClassOf: { "@id": "rdfs:subClassOf", "@type": "@id" },
    domain: { "@id": "rdfs:domain", "@type": "@id" },
    range: { "@id": "rdfs:range", "@type": "@id" },
    label: "rdfs:label",
    title: "dct:title",
    format: "dct:format",
    description: { "@id": "dct:description", "@type": "@id" },
    modified: { "@id": "dct:modified", "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    created: { "@id": "dct:created", "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    creator: { "@id": "dct:creator", "@type": "@id" },
    accountName: "foaf:accountName",
    name: "foaf:name",
    Container: "sioc:Container",
    UserAccount: "sioc:UserAccount",
    content: "sioc:content",
    has_container: { "@id": "sioc:has_container", "@type": "@id" },
    RelationInstance: "dgb:RelationInstance",
    NodeSchema: "dgb:NodeSchema",
    source: { "@id": "dgb:source", "@type": "@id" },
    destination: { "@id": "dgb:destination", "@type": "@id" },
    SourceDocument: "mira:SourceDocument",
    Argument: "mira:Argument",
    describesActivity: { "@id": "mira:describesActivity", "@type": "@id" },
    opposes: { "@id": "mira:opposes", "@type": "@id" },
    supports: { "@id": "mira:supports", "@type": "@id" },
    addresses: { "@id": "mira:addresses", "@type": "@id" },
    Question: "mira:Question",
    Claim: "mira:Claim",
    Evidence: "mira:Evidence",
    Request: "mira:Request",
    Protocol: "mira:Protocol",
    Study: "mira:Study", // override mira.jsonld's Study->mira:Protocol bug
    Item: "sioc:Item",
    follows: { "@id": "mira:follows", "@type": "@id" },
    grounds: { "@id": "mira:grounds", "@type": "@id" },
  };
}

const short = (c: string) => (c && c.startsWith(NS) ? c.slice(NS.length) : c);
const slug = (s: any) => String(s || "unknown").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "unknown";
function truncate(s: any, n: number) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function isoOrNow(s: any) { const d = s ? new Date(s) : null; return d && !isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString(); }
function sourceIri(rec: Rec, fallback: string) {
  const doi = rec.doi && String(rec.doi).trim();
  if (doi) return /^https?:\/\//i.test(doi) ? doi : "https://doi.org/" + doi.replace(/^doi:/i, "");
  const url = rec.url && String(rec.url).trim();
  if (url && /^https?:\/\//i.test(url)) return url;
  return fallback;
}

export function toMiraJsonld(
  built: Built,
  opts: { paper?: Rec | null; source?: string; attributedTo?: string; generatedAt?: string } = {},
): MiraExportResult {
  const nodes = built.nodes || [];
  const edges = built.edges || [];
  const report: MiraExportReport = {
    source: opts.source ?? null,
    nodes: { total: nodes.length, mapped: 0, byClass: {}, droppedTypes: {} },
    edges: { total: edges.length, mapped: 0, byPredicate: {}, droppedTypes: {}, droppedDangling: 0 },
    omittedFields: [], notes: [],
  };

  const idById = new Map<string, string>();
  const clsById = new Map<string, string>();
  const accounts = new Map<string, string>();
  const used = new Set<string>();
  const nodeObjs: Rec[] = [];
  let seq = 0;

  const account = (id: string | undefined, name?: string) => {
    const aid = "agent:" + slug(id || opts.attributedTo || "rrgi:export");
    if (!accounts.has(aid)) accounts.set(aid, truncate(name || id || opts.attributedTo || "RRGI extractor", 512));
    return aid;
  };
  const omit = { sourceType: false, doi: false, epistemicStatus: false, contextEntities: false } as Record<string, boolean>;

  for (const n of nodes) {
    const cls = NODE_CLASS[short(n.collection)];
    if (!cls) { report.nodes.droppedTypes[short(n.collection)] = (report.nodes.droppedTypes[short(n.collection)] || 0) + 1; continue; }
    const r = n.record || {};
    const key = short(n.collection);
    const id = key === "source" ? sourceIri(r, "rrgi:n" + seq) : "rrgi:n" + seq;
    seq++;
    idById.set(n.id, id);
    clsById.set(n.id, cls);
    used.add(cls);
    report.nodes.mapped++;
    report.nodes.byClass[cls] = (report.nodes.byClass[cls] || 0) + 1;

    const created = isoOrNow(r.createdAt);
    const obj: Rec = {
      "@id": id,
      "@type": ["rrgi:_schema_" + key, cls],
      title: truncate(r.text, 200),
      content: r.description ? `${r.text}\n\n${r.description}` : String(r.text || ""),
      created,
      modified: created,
      creator: account(r.provenance?.wasAttributedTo, r.provenance?.wasAttributedTo),
    };
    const excerpt = r.provenance?.excerpt && String(r.provenance.excerpt).trim();
    if (excerpt) obj.description = { "@type": "Item", format: "text/plain", content: excerpt };
    nodeObjs.push(obj);

    if (key === "source" && r.sourceType) omit.sourceType = true;
    if (key === "source" && r.doi && !String(id).startsWith("http")) omit.doi = true;
    if (r.epistemicStatus) omit.epistemicStatus = true;
    if (Array.isArray(r.contextEntities) && r.contextEntities.length) omit.contextEntities = true;
  }
  for (const k of Object.keys(omit)) if (omit[k]) report.omittedFields.push(k);

  const schemaDefs: Rec[] = [];
  for (const cls of used) {
    const key = Object.keys(NODE_CLASS).find((k) => NODE_CLASS[k] === cls)!;
    schemaDefs.push({ "@id": "rrgi:_schema_" + key, "@type": "NodeSchema", subClassOf: [cls], label: cls });
  }

  const relObjs: Rec[] = [];
  let reli = 0;
  for (const e of edges) {
    const pred = REL_PRED[e.relation];
    if (!pred) { report.edges.droppedTypes[e.relation] = (report.edges.droppedTypes[e.relation] || 0) + 1; continue; }
    const src = idById.get(e.subject);
    const dst = idById.get(e.object);
    if (!src || !dst) { report.edges.droppedDangling++; continue; }
    relObjs.push({
      "@id": "reli:" + reli++,
      "@type": ["rel:" + pred, "RelationInstance"],
      predicate: "mira:" + pred,
      source: src,
      destination: dst,
      title: `${clsById.get(e.subject)} -${pred}-> ${clsById.get(e.object)}`,
      creator: account(opts.attributedTo),
    });
    report.edges.mapped++;
    report.edges.byPredicate[pred] = (report.edges.byPredicate[pred] || 0) + 1;
  }

  const accountObjs: Rec[] = [];
  for (const [id, nm] of accounts) accountObjs.push({ "@id": id, "@type": "UserAccount", accountName: nm });

  const doc: Rec = { "@context": [miraContext()], "@graph": [...accountObjs, ...schemaDefs, ...nodeObjs, ...relObjs] };
  if (opts.generatedAt) doc["prov:generatedAtTime"] = opts.generatedAt;

  if (report.omittedFields.length) report.notes.push("Omitted (no canonical MIRA slot on the closed node shapes): " + report.omittedFields.join(", ") + ".");
  const dRel = Object.keys(report.edges.droppedTypes);
  if (dRel.length) report.notes.push("RRGI-only relations dropped (no MIRA shape): " + dRel.join(", ") + ".");
  const dNode = Object.keys(report.nodes.droppedTypes);
  if (dNode.length) report.notes.push("RRGI-only node types dropped (no MIRA shape): " + dNode.join(", ") + ".");

  return { jsonld: doc, report };
}
