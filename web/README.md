# MIRA Graph Extractor — Web UI

A Next.js front end over the parent library. Upload or paste a paper, run the extraction
**server-side** (your OpenRouter key never reaches the browser), then **edit the proposed
graph** as an interactive node-link diagram — fix nodes, fix relations, check anchors against
the source — and export the refined graph.

Extraction reuses `../src` directly (the same `decompose()` the CLI uses). The editing layer
is all client-side: the extracted graph becomes an in-memory **staging model** you mutate
before export. Nothing is published or signed.

## Run it

```bash
cd web
npm install
cp .env.local.example .env.local   # add your OpenRouter key (or paste one per-run in the UI)
npm run dev                         # http://localhost:3030
```

Get a key at <https://openrouter.ai/keys>.

## What you get

**Extract** — paste text or upload a `.pdf` / `.txt` / `.md` (optional API-key and
attributed-to-DID overrides). Long papers are chunked and merged by the library.

**Edit the staged graph** (three synced surfaces over one model):

- **Center — the graph.** Nodes colored by type (question · claim · evidence · study ·
  source); edges labeled/colored by relation. Empty-text nodes and ungrammatical edges show
  red. **Drag from a node's bottom dot to another node's top dot to draw a new relation** —
  only grammar-legal directed relations are accepted.
- **Right — the inspector/editor.** Click a node to edit its text, type, description,
  epistemic status, source type / DOI / URL, and its **anchor** (with a live
  `✓ found` / `≈ differs` / `⚠ not found` check against the source). Click a relation to
  change its type (grammar-filtered), **re-point its endpoints**, or edit its anchor.
  Drop / restore anything (soft-delete — nothing is lost until export).
- **Left — the rail.** A **ready-to-export gate** (clickable list of empty nodes / bad
  relations to fix), live counts, editable **paper metadata** (title / authors / ORCID /
  DOI / license), an **add-node** form, and a **recovery zone** to restore dropped items.
  Then **Export graph** (only kept, non-empty nodes and grammar-valid relations; user-added
  nodes are stamped `wasGeneratedBy: "humanAuthored"`).

## How it's wired

- `app/api/extract/route.ts` (Node runtime) reads the upload, runs the parent `decompose()`
  (+ `lib/pdf.ts` for PDFs), and returns the `DecomposeResult` plus the extracted text.
- `lib/staging.ts` — the editable model: grammar (mirrors `src/grammar.ts`), `buildStageModel`,
  `validate`, the `ops.*` mutations, and `exportGraph`.
- `lib/layout.ts` — dagre layout → React Flow nodes/edges, validity-aware styling.
- `components/` — `GraphView` (canvas + draw-to-connect), `Inspector` (node/edge editor),
  `StagePanel` (rail), `InputForm`.
- `next.config.mjs` keeps `pdfjs-dist` external so PDF parsing matches the CLI.

It's a **draft for human review** — now genuinely reviewable *and editable*. Nothing is
published or signed; export is a local JSON download.
