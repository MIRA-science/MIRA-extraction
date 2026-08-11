/**
 * make-fixture.ts — regenerate examples/sample.mira.jsonld deterministically.
 *
 * The fixture is a synthetic extraction exercising every node class, every
 * relation, the anchor convention, the sourceDocument stamps, and the
 * attribution capture — pinned to a fixed timestamp so the file only changes
 * when the projection changes. CI validates this file against the vendored
 * MIRA SHACL shapes (see schema/Makefile `validate`).
 *
 *   npm run fixture
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyGraph, type RawGraph } from "../src/grammar.ts";
import { mergeGraphs } from "../src/merge.ts";
import { toMiraJsonld } from "../src/to-mira-jsonld.ts";

const here = dirname(fileURLToPath(import.meta.url));

const raw: RawGraph = {
  paper: {
    title: "Persistence of content-addressed research objects",
    doi: "10.1234/sample",
    license: "CC BY 4.0",
    authors: [{ name: "Ada Lovelace", orcid: "0000-0002-1825-0097" }, { name: "Grace Hopper" }],
  },
  nodes: [
    { id: "q1", type: "Question", text: "Do content-addressed research objects remain retrievable over time?", anchor: "remain retrievable over a 30-day observation window" },
    { id: "c1", type: "Claim", text: "Content-addressed storage keeps research objects retrievable.", anchor: "we conclude that content addressing preserves retrievability" },
    { id: "c2", type: "Claim", text: "Retrievability depends on replication across independent nodes.", description: "Argued from the observed failure modes." },
    { id: "e1", type: "Evidence", text: "94% of objects remained retrievable after 30 days.", anchor: "470 (94%) were still retrievable on day 30" },
    { id: "e2", type: "Evidence", text: "Objects pinned on one node only were lost at 3× the rate." },
    { id: "st1", type: "Study", text: "A 30-day retrievability audit of 500 pinned objects.", anchor: "we audited 500 objects over 30 days" },
    { id: "p1", type: "Protocol", text: "Daily retrieval probe against every pinned CID.", anchor: "each CID was probed once every 24 hours" },
    { id: "s1", type: "SourceDocument", text: "Persistence of content-addressed research objects", doi: "10.1234/sample" },
    { id: "s2", type: "SourceDocument", text: "An earlier availability study of distributed storage", doi: "10.5555/earlier" },
    { id: "r1", type: "Request", text: "Repeat the audit at a 12-month horizon.", anchor: "future work should extend the audit to a full year" },
  ],
  edges: [
    { relation: "addresses", subject: "c1", object: "q1" },
    { relation: "supports", subject: "e1", object: "c1", anchor: "this result supports the retrievability conclusion" },
    { relation: "supports", subject: "e2", object: "c2" },
    { relation: "supports", subject: "c1", object: "c2" },
    { relation: "describesActivity", subject: "s1", object: "st1" },
    { relation: "grounds", subject: "st1", object: "e1" },
    { relation: "follows", subject: "st1", object: "p1" },
    { relation: "request_target", subject: "r1", object: "c1" },
  ],
};

const g = classifyGraph(raw);
if (g.dropped.nodes.length || g.dropped.danglingEdges.length || g.dropped.ungrammaticalEdges.length)
  throw new Error("fixture input must classify clean: " + JSON.stringify(g.dropped));
const merged = mergeGraphs([g]);

const { jsonld, report } = toMiraJsonld(
  { nodes: merged.nodes, edges: merged.edges, paper: raw.paper as never },
  { slug: "sample", generatedAt: "2026-01-01T00:00:00.000Z", creatorName: "MIRA-extraction fixture" },
);

const out = join(here, "..", "examples", "sample.mira.jsonld");
writeFileSync(out, JSON.stringify(jsonld, null, 2) + "\n");
console.log("wrote", out);
console.log("report:", JSON.stringify(report, null, 2));
