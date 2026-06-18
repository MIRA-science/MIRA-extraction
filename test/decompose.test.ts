/**
 * Offline test of the pure pipeline — parse, grammar classification, record shapes,
 * anchor + paper cleaning. NO network, NO pdf.js, NO API key: it feeds a synthetic
 * model reply (the part we control) and asserts the transform. Run:  npm test
 */
import { parseGraph, cleanPaper } from "../src/decompose.ts";
import { buildGraph, cleanAnchor, EDGE_GRAMMAR } from "../src/grammar.ts";

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };

console.log("mira-graph-extractor — offline pipeline test");

// 1) parseGraph tolerates a code fence, raw JSON, and trailing prose; rejects junk
const fenced = "```json\n{\"nodes\":[],\"edges\":[]}\n```";
ok(parseGraph(fenced).nodes.length === 0, "parseGraph strips a ```json fence");
ok(parseGraph('{"nodes":[],"edges":[]}').edges.length === 0, "parseGraph reads raw JSON");
ok(parseGraph('Here you go:\n{"nodes":[],"edges":[]}\nhope that helps').nodes.length === 0, "parseGraph recovers from surrounding prose");
let threw = false;
try { parseGraph("not json at all"); } catch { threw = true; }
ok(threw, "parseGraph throws on unparseable output");

// 2) the grammar table is exactly the five legal directed relations (informs is retired)
ok(EDGE_GRAMMAR.addresses.subj.join() === "claim" && EDGE_GRAMMAR.addresses.obj.join() === "question", "addresses: claim→question");
ok(EDGE_GRAMMAR.describes.subj.join() === "source" && EDGE_GRAMMAR.describes.obj.join() === "study", "describes: source→study");
ok(EDGE_GRAMMAR.grounds.subj.join() === "study" && EDGE_GRAMMAR.grounds.obj.join() === "evidence", "grounds: study→evidence");
ok(EDGE_GRAMMAR.supports.subj.join() === "evidence,claim", "supports accepts evidence|claim as subject");
ok(EDGE_GRAMMAR.informs === undefined, "informs is retired from the grammar");

// 3) buildGraph — RRGI record shapes + legal/dangling/ungrammatical split
const raw = {
  paper: { title: "On Persistence", doi: "10.1/x", license: "CC BY 4.0",
           authors: [{ name: "A. Researcher", orcid: "0000-0002-1825-0097" }, { name: "B. Coauthor", orcid: "bogus" }] },
  nodes: [
    { id: "q1", type: "question", text: "Does it persist?", anchor: "we ask whether the data persists over time" },
    { id: "c1", type: "claim", text: "It persists.", epistemicStatus: "claim" },
    { id: "e1", type: "evidence", text: "Re-fetched after 30 days." },
    { id: "st1", type: "study", text: "A 30-day persistence field study", anchor: "we measured retrievability over 30 days" },
    { id: "s1", type: "source", text: "The persistence paper", sourceType: "paper", doi: "10.1/y" },
    { id: "bad", type: "method", text: "should be skipped — unknown type" },
    { id: "notext", type: "claim", text: "" },
  ],
  edges: [
    { relation: "addresses", subject: "c1", object: "q1", anchor: "“this directly answers the question”" },
    { relation: "supports", subject: "e1", object: "c1" },
    { relation: "describes", subject: "s1", object: "st1" },     // legal: source→study
    { relation: "grounds", subject: "st1", object: "e1" },       // legal: study→evidence
    { relation: "grounds", subject: "s1", object: "e1" },        // ungrammatical: grounds wants study→evidence (the old informs shape)
    { relation: "informs", subject: "s1", object: "e1" },        // ungrammatical: informs is retired (unknown relation)
    { relation: "addresses", subject: "c1", object: "ghost" },   // dangling: ghost undefined
  ],
};
const g = buildGraph(raw as any, "did:plc:TEST", "on-persistence");

ok(g.nodes.length === 5, "buildGraph keeps the 5 well-formed nodes, skips the unknown-type + empty-text ones");
const claim = g.nodes.find((n) => n.id === "c1")!;
ok(claim.collection === "tech.scios.rrgi.claim", "claim → tech.scios.rrgi.claim collection");
ok((claim.record as any).$type === "tech.scios.rrgi.claim", "record carries the $type");
ok((claim.record as any).epistemicStatus === "claim", "claim record carries epistemicStatus");
ok((claim.record.provenance as any).wasGeneratedBy === "aiAssistedExtraction", "provenance.wasGeneratedBy = aiAssistedExtraction");
ok((claim.record.provenance as any).wasAttributedTo === "did:plc:TEST", "provenance.wasAttributedTo = the passed DID");
ok(JSON.stringify((claim.record as any).tags) === JSON.stringify(["on-persistence", "c1"]), "record tags = [slug, id]");
const q1 = g.nodes.find((n) => n.id === "q1")!;
ok((q1.record.provenance as any).excerpt === "we ask whether the data persists over time", "node anchor → provenance.excerpt");
const study = g.nodes.find((n) => n.id === "st1")!;
ok(study.collection === "tech.scios.rrgi.study", "study → tech.scios.rrgi.study collection");
ok((study.record as any).$type === "tech.scios.rrgi.study" && (study.record as any).epistemicStatus === undefined, "study record uses the generic node shape (no epistemicStatus)");
ok((study.record.provenance as any).excerpt === "we measured retrievability over 30 days", "study anchor → provenance.excerpt");
const src = g.nodes.find((n) => n.id === "s1")!;
ok((src.record as any).sourceType === "paper" && (src.record as any).doi === "10.1/y", "source record carries sourceType + doi");

ok(g.edges.length === 4, "4 legal edges kept (c1 addresses q1, e1 supports c1, s1 describes st1, st1 grounds e1)");
ok(g.edges.some((e) => e.relation === "describes" && e.subject === "s1" && e.object === "st1"), "source→study describes is legal");
ok(g.edges.some((e) => e.relation === "grounds" && e.subject === "st1" && e.object === "e1"), "study→evidence grounds is legal");
ok(g.edges.some((e) => e.relation === "addresses" && e.anchor === "this directly answers the question"), "edge anchor is cleaned (wrapping smart-quotes stripped)");
ok(g.dangling.length === 1 && g.dangling[0].object === "ghost", "the ghost-endpoint edge is reported as dangling");
ok(g.ungrammatical.length === 2, "two ungrammatical edges reported");
ok(g.ungrammatical.some((u) => u.edge.relation === "grounds" && u.why.includes("grounds wants study→evidence")), "source→evidence under grounds is ungrammatical (the old informs shape)");
ok(g.ungrammatical.some((u) => u.edge.relation === "informs" && u.why.includes('unknown relation "informs"')), "a retired informs relation is reported as unknown");

// 4) cleanAnchor — strips wrapping quotes, collapses control chars, caps length
ok(cleanAnchor('“a quoted passage”') === "a quoted passage", "cleanAnchor strips smart quotes");
ok(cleanAnchor("a\tb\nc") === "a b c", "cleanAnchor collapses control chars");
ok(cleanAnchor(123 as any) === "", "cleanAnchor returns '' for non-strings");
ok(cleanAnchor("x".repeat(300)).length === 256, "cleanAnchor caps at 256 chars");

// 5) cleanPaper — keeps grounded attribution, drops a malformed ORCID, never fabricates
const paper = cleanPaper(raw.paper)!;
ok(paper.title === "On Persistence" && paper.doi === "10.1/x" && paper.license === "CC BY 4.0", "paper title/doi/license preserved");
ok(paper.authors!.length === 2, "both authors kept");
ok(paper.authors![0].orcid === "0000-0002-1825-0097", "valid ORCID kept");
ok(paper.authors![1].orcid === undefined, "malformed ORCID dropped, not fixed");
ok(cleanPaper({}) === null, "empty paper → null");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
