# MIRA-extraction

Turn a research paper into a **validated MIRA graph**.

This tool was developed by **[SciOS](https://scios.tech)** as the extraction
engine of **RRGI** ([graph.scios.tech](https://graph.scios.tech)), a production
research-graph deployment built on the MIRA schema, and is contributed back
upstream here so every MIRA tool can share one extraction layer. The engine is
field-tested in that deployment; what this repo emits is **pure MIRA** — the
community's schema, nothing else.

```
PDF / .txt / .md ──▶ pinned free LLM ──▶ canonical MIRA JSON-LD
                                         (+ working graph + honesty report)
```

It is a *draft generator for human review*. It **publishes nothing, signs
nothing, and talks to no network except the LLM.**

## The model

Seven node classes and eight relations — named exactly as
[`mira.yaml`](https://github.com/MIRA-science/schema) names them. There is no
internal-to-MIRA translation table anywhere in this tool: what the extractor
emits is what the schema says.

| node class | what it is |
|---|---|
| `Question` | a scientific unknown posed for systematic study |
| `Claim` | an atomic, generalized assertion the authors make |
| `Evidence` | a specific empirical observation from applying a research method |
| `Study` | the investigation/experiment/analysis that produces evidence |
| `Protocol` | the method a study follows to generate evidence |
| `SourceDocument` | a document that reports a study (the paper itself, and works it cites) |
| `Request` | a unit of work the paper calls for (a proposed experiment, an open problem) |

| relation | legal direction |
|---|---|
| `addresses` | `Claim → Question` |
| `supports` / `opposes` | `Evidence \| Claim → Claim` |
| `describesActivity` | `SourceDocument → Study` |
| `grounds` | `Study → Evidence` |
| `follows` | `Study → Protocol` |
| `request_for` | `Request → Study` |
| `request_target` | `Request → Claim` |

The provenance spine is `SourceDocument —describesActivity→ Study —grounds→
Evidence`, with methods on `Study —follows→ Protocol`. Every `Evidence` also
carries `mira:sourceDocument` directly — derived along the spine when its study
is described by a source, else the paper itself.

**One interpretation, stated plainly:** MIRA's `Argument` mixin ("a node that
can support or oppose another node") is assigned to no class — the schema
leaves open *who may argue*. This tool accepts **both a Claim and Evidence** as
the subject of `supports`/`opposes`, consistent with the schema repo's own
`sampleData.json` (which shows a claim supporting a claim) while keeping the
evidence→claim link the `Evidence` class exists to provide.

## What makes the output trustworthy

- **One paper, one call.** The whole paper goes to the model in a single
  prompt — never chunked, never truncated. A paper over the 400K-character
  single-call limit is **refused with a clear error** (the web app offers to
  collect it for maintainer review) rather than silently split or cut.
- **Anchors.** Every node (and groundable relation) carries a short **verbatim
  quote** from the paper, emitted in the schema's own grounding convention (an
  `Item` in the paper's document `Container`) — each record is checkable
  against any copy of the paper.
- **Report, never drop.** Malformed nodes, ungrammatical edges, dangling
  edges, failed pieces, and fields with no MIRA slot are all counted and
  returned with reasons. A partial extraction says so.
- **Duplicate folding before output.** A mechanical exact-text fold plus one
  conservative model pass over the whole record list (merges only — a
  configuration chosen after field review) keep piece-boundary duplicates from
  masquerading as independent statements.
- **Validated shape.** CI regenerates the example output and validates it
  against the schema repo's own generated SHACL shapes (see
  [`schema/`](schema/README.md)).
- **One pinned model, free by default.** The default model id ends in `:free`,
  so a default run costs $0, and there is **no fallback chain**: if the pinned
  model can't serve the call — or a different model answers it — the run fails
  with an error rather than extracting with a model you didn't choose. Each run
  prints its cost receipt and warns if it wasn't free.

## Install

Requires Node ≥ 18.18.

```bash
npm install
cp .env.example .env      # put your OpenRouter key in .env
```

Get a key at <https://openrouter.ai/keys>. Any OpenAI-compatible chat endpoint
works if you adapt `src/transport.ts`.

## Use it — CLI

```bash
npm run extract -- examples/sample.txt
npm run extract -- ./some-paper.pdf --slug my-paper
```

Prints the extraction report and writes two artifacts:

- **`<name>.mira.jsonld`** — canonical MIRA JSON-LD, the headline output
- `<name>.graph.json` — the working graph + full report (debug artifact)

Flags: `--slug name` · `--creator name` · `--model id` · `--out dir`

## Use it — library

```ts
import { decompose } from "./src/index.ts";

const res = await decompose(
  { file: "paper.pdf" },                    // or { text: "..." }
  { apiKey: process.env.OPENROUTER_API_KEY },
);

res.jsonld;    // canonical MIRA JSON-LD (the headline output)
res.nodes;     // the classified records (one id namespace)
res.edges;     // the legal relations
res.dropped;   // everything rejected, with reasons
res.report;    // the projection's report (counts, stamps, omissions)
res.paper;     // grounded title/authors(ORCID)/doi/license, if printed in the text
```

## Validation

```bash
pip install pyshacl
cd schema && make vendor && make validate
```

The schema is pinned by commit and the fixture output is validated against the
schema repo's own `mira.shacl` — alignment is checked, not claimed. See
[`schema/README.md`](schema/README.md), including the short list of known
generated-shape quirks at the current pin (which the schema repo's own sample
data also trips).

## Honest limitations

- **Multi-column PDFs.** pdf.js yields positioned fragments, not reading
  order; column reconstruction is weak. For best results feed clean `.txt`/`.md`.
- **An LLM can be wrong.** It may miss argument structure, and it *can*
  fabricate a number, DOI, or citation. **Review the output before trusting
  it** — the anchor quotes exist precisely so each record can be checked.
- **`Request` extraction and claim→claim argument links are newer** than the
  rest of the pipeline: the engine is field-tested, but those two prompt rules
  have had less corpus time. Treat them with extra review attention.
- **Papers over 400K characters are refused**, not split — one paper is one
  model call, always. The chunking machinery in the repo (`chunk.ts`,
  `merge.ts`, `consolidate.ts`) is unwired, kept as the starting point for a
  future system.

## Test

```bash
npm test              # offline — parsing, grammar, chunking, merge, consolidation, projection
npm run typecheck
npm run fixture       # regenerate examples/sample.mira.jsonld (deterministic)
```

## Provenance & lineage

Built by **SciOS** and ported upstream from the RRGI deployment's extraction
pipeline (prompt discipline, chunking, merge + consolidation, transport
watchdogs — field-tested at graph.scios.tech; last synced 2026-08-10). RRGI
itself extends MIRA for its own use case (versioning, equivalence,
endorsements, and more, in its own namespace); **none of that is emitted
here** — this tool produces the community schema, so anything can build on it.
Fields the schema has no slot for (e.g. a paper's printed license) are carried
in the run report, never silently lost.

## License

TBD.
