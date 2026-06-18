/**
 * CLI — dry-run extractor.
 *
 *   npm run extract -- "<paper.pdf | paper.txt | paper.md>" [attributedToDid]
 *
 * Reads the OpenRouter key from $OPENROUTER_API_KEY or a local .env file. Prints a
 * report and writes the proposed graph to "<name>.graph.json" in the current dir.
 * Publishes nothing; signs nothing.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { decompose, MAX_CHUNKS } from "../src/index.ts";
import { TYPE_TO_COLLECTION } from "../src/grammar.ts";

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

const [path, attributedTo = "did:plc:PLACEHOLDER"] = process.argv.slice(2);
if (!path) {
  console.error('usage: npm run extract -- "<paper.pdf|.txt|.md>" [attributedToDid]');
  process.exit(1);
}
const apiKey = loadKey();
if (!apiKey) {
  console.error("no OPENROUTER_API_KEY — put it in a .env file (see .env.example) or export it.");
  process.exit(1);
}

console.log("=== MIRA graph extractor (dry-run) ===");
console.log("input:", path);

const res = await decompose({ file: path }, { apiKey, attributedTo });

console.log(
  `extracted ${res.fullChars.toLocaleString()} chars` +
    (res.chunks > 1 ? ` → split into ${res.chunks} overlapping windows, merged` : "") +
    (res.truncated ? ` (capped at ${MAX_CHUNKS} windows — a long tail was left uncovered)` : ""),
);
console.log("model:", res.model);

// ---- attribution ----
if (res.paper) {
  console.log("\nPAPER (extraction-time attribution — groundable-in-text only):");
  if (res.paper.title) console.log("  title  :", res.paper.title);
  if (res.paper.authors)
    console.log("  authors:", res.paper.authors.map((a) => (a.orcid ? `${a.name} (ORCID ${a.orcid})` : a.name)).join(", "));
  if (res.paper.doi) console.log("  doi    :", res.paper.doi);
  if (res.paper.license) console.log("  license:", res.paper.license);
} else {
  console.log("\nPAPER: (none grounded in the text)");
}

// ---- counts ----
const byType: Record<string, number> = {};
for (const n of res.built.nodes) {
  const k = n.collection.split(".").pop()!;
  byType[k] = (byType[k] ?? 0) + 1;
}
const byRel: Record<string, number> = {};
for (const e of res.built.edges) byRel[e.relation] = (byRel[e.relation] ?? 0) + 1;

console.log("\nNODES:", byType, "→ total", res.built.nodes.length);
console.log("EDGES:", byRel, "→ total", res.built.edges.length);

// ---- anchor coverage (the grounding quotes) ----
const anchoredNodes = res.built.nodes.filter((n) => (n.record.provenance as Record<string, unknown>)?.excerpt).length;
const anchoredEdges = res.built.edges.filter((e) => e.anchor).length;
console.log(`ANCHORS: ${anchoredNodes}/${res.built.nodes.length} nodes · ${anchoredEdges}/${res.built.edges.length} edges carry a verbatim grounding quote`);

// ---- rejected edges (reported, never silently dropped) ----
if (res.built.dangling.length) {
  console.log(`\nDANGLING edges (endpoint id missing): ${res.built.dangling.length}`);
  for (const d of res.built.dangling.slice(0, 10)) console.log("   ", d.relation, d.subject, "→", d.object);
}
if (res.built.ungrammatical.length) {
  console.log(`\nUNGRAMMATICAL edges (violate the grammar): ${res.built.ungrammatical.length}`);
  for (const u of res.built.ungrammatical.slice(0, 10)) console.log("   ", u.why, `[${u.edge.subject}→${u.edge.object}]`);
}

// ---- a sample record of each kind ----
console.log("\n=== SAMPLE NODE RECORDS ===");
for (const coll of Object.values(TYPE_TO_COLLECTION)) {
  const n = res.built.nodes.find((x) => x.collection === coll);
  if (n) console.log(`\n# ${n.id} → ${n.collection}\n${JSON.stringify(n.record, null, 2)}`);
}

// ---- persist ----
const outPath = resolve(process.cwd(), `${basename(path).replace(/\.[^.]+$/, "")}.graph.json`);
writeFileSync(outPath, JSON.stringify(res, null, 2));
console.log("\nwrote proposed graph →", outPath);
console.log("\n(DRY-RUN — nothing was published; no record was signed.)");
