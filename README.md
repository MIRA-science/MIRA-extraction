# MIRA Graph Extractor

Turn a research paper (PDF or text) into a **proposed MIRA graph** — a set
of citable records connected by typed relations — with a call to **Mistral Large**
(several, merged, for long papers).

It is a *draft generator for human review*. It **publishes nothing, signs nothing, and
talks to no network except the LLM**. No AT Protocol, no IPFS, no database, no UI.

```
PDF / .txt / .md  ──▶  Mistral Large  ──▶  { question · claim · evidence · study · source }
                                           nodes, connected by typed relations
```

## The model

A paper is decomposed into five **node** types and five **relation** types:

| node | what it is |
|------|-----------|
| `question` | a research question the paper investigates |
| `claim` | a statement the authors assert (finding, conclusion, hypothesis) |
| `evidence` | a specific result/observation that can support or oppose a claim |
| `study` | a specific investigation/experiment/analysis that produces evidence |
| `source` | a document (paper, preprint, dataset, book) that reports a study |

| relation | legal direction |
|----------|-----------------|
| `addresses` | `claim → question` |
| `supports` | `evidence \| claim → claim` |
| `opposes` | `evidence \| claim → claim` |
| `describes` | `source → study` |
| `grounds` | `study → evidence` |

The provenance spine is **`source —describes→ study —grounds→ evidence`**, mirroring MIRA's
`describesActivity` + `grounds`. The older single-hop `source —informs→ evidence` is **retired**:
new graphs insert a `study` between a source and the evidence it grounds.

Edges that dangle (an endpoint id doesn't exist) or violate the grammar are **reported,
never silently dropped** — they come back in `built.dangling` / `built.ungrammatical`.

Every node also carries an **anchor**: a short verbatim quote from the spot in the paper
that grounds it, stored as `provenance.excerpt` — the record's grounding in the source's
own words, checkable against any copy of the paper.

## Install

Requires Node ≥ 18.18.

```bash
npm install
cp .env.example .env      # then put your OpenRouter key in .env
```

Get a key at <https://openrouter.ai/keys>. (Any OpenAI-compatible chat endpoint works if
you adapt `callOpenRouter` in `src/decompose.ts`.)

## Use it — CLI

```bash
npm run extract -- examples/sample.txt
# or a real paper:
npm run extract -- ./some-paper.pdf
```

Prints a report (node/edge counts, anchor coverage, rejected edges, sample records) and
writes the full proposed graph to `<name>.graph.json`. See `examples/sample.output.json`
for the output shape.

## MIRA output

`npm run extract` also writes `<name>.mira.jsonld` (via `src/to-mira-jsonld.ts`).
This repo is an older snapshot; the current RRGI system is at https://graph.scios.tech.

This repo → MIRA:

| this repo | MIRA |
|---|---|
| question | Question |
| claim | Claim |
| evidence | Evidence |
| study | Study |
| source | SourceDocument |
| addresses | addresses |
| supports / opposes | supports / opposes |
| grounds | grounds |
| describes | describesActivity |

RRGI → MIRA:

| RRGI | MIRA |
|---|---|
| question | Question |
| claim | Claim |
| evidence | Evidence |
| study | Study |
| source | SourceDocument |
| protocol | Protocol |
| addresses | addresses |
| supports / opposes | supports / opposes |
| grounds | grounds |
| follows | follows |
| describes | describesActivity |

RRGI extends MIRA (no MIRA equivalent):

| RRGI | what it is |
|---|---|
| derivedFrom | a claim built from other claims |
| contradicts | claims that can't both hold |
| equivalentTo | same proposition, different words |
| versionOf | a revision |
| endorsement | a signed stance on any record |
| stemsFrom / tradition | field of origin (domains) |

## Use it — library

```ts
import { decompose } from "./src/index.ts";

const result = await decompose(
  { file: "paper.pdf" },              // or { text: "..." }
  { apiKey: process.env.OPENROUTER_API_KEY },
);

result.built.nodes;          // record-shaped question/claim/evidence/source nodes
result.built.edges;          // the legal relations
result.built.dangling;       // edges whose endpoints don't resolve
result.built.ungrammatical;  // edges that break the grammar
result.paper;                // grounded title/authors/doi/license, if printed in the text
```

## Output shape

Nodes come back as records (`built.nodes[].record`). The `$type` and `provenance` fields
use the [RRGI](https://github.com/) MIRA-graph vocabulary so the output can later be
fed into an RRGI/AT-Protocol system — but **producing them needs nothing from ATProto**;
they are plain JSON:

```json
{
  "$type": "tech.scios.rrgi.claim",
  "text": "94% of objects remained retrievable after 30 days.",
  "epistemicStatus": "claim",
  "tags": ["sample", "c1"],
  "provenance": {
    "wasGeneratedBy": "aiAssistedExtraction",
    "wasAttributedTo": "did:plc:PLACEHOLDER",
    "excerpt": "470 (94%) were still retrievable on day 30"
  },
  "createdAt": "2026-06-12T00:00:00.000Z"
}
```

`provenance.wasGeneratedBy: "aiAssistedExtraction"` is the honest record that a machine
drafted this. `wasAttributedTo` defaults to a placeholder DID — pass `attributedTo` to
set the eventual author; nothing is signed either way.

## Configuration

Per-call via the second argument to `decompose()`, or edit the defaults in
`src/decompose.ts`:

- `apiKey` — OpenRouter key (defaults to `OPENROUTER_API_KEY`).
- `model` — the model (default `mistralai/mistral-large`). There is **no fallback chain**: a
  failed call is retried against the *same* model, never a weaker one (a weak model collapses
  the graph to a few nodes). `retries` sets the per-window retry count (default 1).
- `maxInputChars` — per-window size (default 40,000). Longer papers are split into overlapping
  windows and merged; `chunkOverlap` (default 2,500) and `maxChunks` (default 8) tune that.
- `attributedTo`, `slug`, `timeoutMs`.

## Honest limitations

- **Long papers are chunked.** Papers over 40K chars are split into overlapping ~40K windows
  (up to 8), each decomposed with its own Mistral call, then merged and de-duplicated by
  normalized node text. A paper longer than the window cap leaves a tail uncovered — the
  report flags truncation.
- **Multi-column PDFs.** `pdf.js` yields positioned fragments, not reading order; column
  reconstruction is weak. For best results, feed clean `.txt`/`.md`.
- **It's a draft, and an LLM can be wrong.** It may miss argument structure, and it *can*
  fabricate a number, DOI, or citation. **Review the output before trusting it.** The
  anchor quotes exist precisely so you can check each record against the paper.
- Tuned for **research papers**.

## Test

```bash
npm test     # offline — exercises parsing, the grammar, and record-building (no network)
```

## Provenance

Extracted from the RRGI infrastructure project's `decompose-pdf` pipeline. The publishing,
storage (IPFS), identity (AT Protocol), and visualization layers were intentionally left
out — this is *only* the extraction capability.

## License

TBD.
