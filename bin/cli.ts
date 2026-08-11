/**
 * CLI — extract one paper into a MIRA graph.
 *
 *   npm run extract -- "<paper.pdf | paper.txt | paper.md>" [--slug name]
 *        [--model id] [--creator name] [--out dir]
 *
 * Reads the OpenRouter key from $OPENROUTER_API_KEY or a local .env file.
 * Writes two artifacts next to the input (or into --out):
 *   <name>.mira.jsonld  — canonical MIRA JSON-LD (THE output)
 *   <name>.graph.json   — the working graph + full report (debug artifact)
 * Publishes nothing; signs nothing. The result is a draft for human review.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { decompose } from "../src/index.ts";

// minimal .env reader (no dependency): OPENROUTER_API_KEY from env, else ./.env
function loadKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*OPENROUTER_API_KEY\s*[:=]\s*(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  return i !== -1 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}
const VALUE_FLAGS = new Set(["--slug", "--model", "--creator", "--out"]);
let path: string | undefined;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (VALUE_FLAGS.has(a)) i++; continue; }
    path = a;
    break;
  }
}
if (!path) {
  console.error('usage: npm run extract -- "<paper.pdf|.txt|.md>" [--slug name] [--model id] [--creator name] [--out dir]');
  process.exit(1);
}
const apiKey = loadKey();
if (!apiKey) {
  console.error("no OPENROUTER_API_KEY — put it in a .env file (see .env.example) or export it.");
  process.exit(1);
}

console.log("=== MIRA extraction ===");
console.log("input:", path);

const res = await decompose(
  { file: path },
  {
    apiKey,
    slug: arg("--slug"),
    model: arg("--model"),
    creatorName: arg("--creator"),
    onProgress: (p) => {
      if (p.phase === "chunked")
        console.log(`read ${p.chars.toLocaleString()} chars → the whole paper in ONE model call`);
      if (p.phase === "decomposing") process.stdout.write(`  extracting … `);
      if (p.phase === "decomposed") console.log(`${p.nodes} nodes / ${p.edges} edges`);
    },
  },
);

// ---- attribution ----
if (res.paper) {
  console.log("\nPAPER (extraction-time attribution — groundable-in-text only):");
  if (res.paper.title) console.log("  title  :", res.paper.title);
  if (res.paper.authors)
    console.log("  authors:", res.paper.authors.map((a) => (a.orcid ? `${a.name} (ORCID ${a.orcid})` : a.name)).join(", "));
  if (res.paper.doi) console.log("  doi    :", res.paper.doi);
  if (res.paper.license) console.log("  license:", res.paper.license, "(reported only — no MIRA slot)");
} else {
  console.log("\nPAPER: (none grounded in the text)");
}

// ---- counts ----
console.log("\nNODES:", res.report.nodes.byClass, "→ total", res.nodes.length);
console.log("EDGES:", res.report.edges.byPredicate, "→ total", res.edges.length);
console.log(
  `ANCHORS: ${res.report.anchors.nodesWithAnchor}/${res.nodes.length} nodes · ` +
    `${res.report.anchors.edgesWithAnchor}/${res.edges.length} edges carry a verbatim grounding quote`,
);
const s = res.report.sourceDocumentStamps;
console.log(`EVIDENCE sourceDocument stamps: ${s.derivedFromSpine} via the study chain · ${s.paperFallback} paper fallback · ${s.unstamped} unstamped`);

// ---- what was rejected / skipped (reported, never silent) ----
const d = res.dropped;
if (d.nodes.length) {
  console.log(`\nDROPPED nodes: ${d.nodes.length}`);
  for (const x of d.nodes.slice(0, 8)) console.log("   ", x.why);
}
if (d.danglingEdges.length) {
  console.log(`DANGLING edges (endpoint id missing): ${d.danglingEdges.length}`);
  for (const x of d.danglingEdges.slice(0, 8)) console.log("   ", x.edge.relation, x.edge.subject, "→", x.edge.object);
}
if (d.ungrammaticalEdges.length) {
  console.log(`UNGRAMMATICAL edges (violate the grammar): ${d.ungrammaticalEdges.length}`);
  for (const x of d.ungrammaticalEdges.slice(0, 8)) console.log("   ", x.why, `[${x.edge.subject}→${x.edge.object}]`);
}
if (res.flakes.length) {
  console.log(`\n⚠ PIECES WITH NO USABLE GRAPH: ${res.flakes.length}/${res.stats.pieces} — this extraction is PARTIAL`);
  for (const f of res.flakes) console.log(`   piece ${f.piece + 1}: ${f.why}`);
}
if (res.stats.consolidation.skipped) console.log("\nconsolidation:", res.stats.consolidation.skipped);
if (res.report.notes.length) console.log("\nnotes:", res.report.notes.join(" "));

// ---- the free-only receipt ----
let cost = 0;
for (const u of res.usage) {
  const c = (u as { cost?: unknown })?.cost;
  if (typeof c === "number") cost += c;
}
console.log(`\nmodels: ${res.models.join(" + ") || "?"} · ${res.usage.length} call(s) · total cost $${cost}`);
if (cost > 0) console.log("⚠ this run was NOT free — check your model configuration");

// ---- write the artifacts ----
const outDir = arg("--out");
if (outDir) mkdirSync(outDir, { recursive: true });
const base = join(outDir || ".", basename(String(path)).replace(/\.[^.]+$/, ""));
writeFileSync(`${base}.mira.jsonld`, JSON.stringify(res.jsonld, null, 2));
writeFileSync(
  `${base}.graph.json`,
  JSON.stringify(
    {
      source: res.source,
      slug: res.slug,
      paper: res.paper,
      nodes: res.nodes,
      edges: res.edges,
      dropped: res.dropped,
      flakes: res.flakes,
      stats: res.stats,
      models: res.models,
      report: res.report,
    },
    null,
    2,
  ),
);
console.log(`\nwrote ${base}.mira.jsonld (canonical MIRA JSON-LD)`);
console.log(`wrote ${base}.graph.json (working graph + report)`);
