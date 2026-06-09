# DECISIONS

_MIRA-extraction · decisions made so far. Canonical log; build details in `BUILD-PLAN.md`. Created 2026-06-09._

## Decided

**Product & scope**
1. Build the funder tool: PDFs → MIRA graph-LD → 4-pane decision view; the extraction engine is the shared core.
2. Domain = all science (no specialization).
3. Process one PDF at a time; a directory upload builds a queue.
4. Build the **proactive** proposal path first; retroactive corpus extraction later.
5. Honor workshop values: open-data-first · advisory, not authoritative · white-box · human-in-the-loop · pluralistic.

**Inputs & what we extract**
6. Output = **MIRA graph-LD only**.
7. Proposal → Q/C/E/Study + the proposed work + a preliminary-results (WIP) subgraph — grouped as one proposal **Bundle**, with proposed-work and WIP as sub-bundles.
8. Mission + CFP (funder-side) → **Questions** (Criteria **dropped** — `Criterion` is proposal-branch-only; revised, see R9). CFP optional, same slot as mission.
9. **Identity layer (revised — R5):** researchers/orgs/funders are first-class **`Agent` identities** (ORCID/ROR/minted-DID), **stamped as authors** (`creator`) and related in-graph via **`affiliatedWith`** — **no human *discourse* nodes**. **ORCID → OpenAlex is a data source** (paper discovery + identities), **not a separate sidecar**; collaboration/standing are in-graph edges + read-time lenses. No ORCID → skip. Proposer's curated/top-N pubs → full extraction (each its own Bundle).
10. Prior art = the proposal's reference list only (v1); deeper expansion → PRSM later.
11. Alignment = **graph connectivity**, not text similarity: proposal Claims `address` mission Questions (**primary signal**) · prior-art overlap (DOI/OpenAlex dedup) · shared `Agent` identities. (Criteria removed with R9; the metric itself is deferred.)

**Extraction method**
12. Centerpiece = a good, **measured** extraction process — not schema extensibility.
13. Model = hosted **Claude/Mistral free tier** now, **swappable backend**; small fine-tuned/volunteer model later.
14. Staged vs joint (nodes then relations) = decided **empirically** by eval; no dogma.
15. Multi-agent reconciliation = design it, but build the single-agent baseline + eval first; it doubles as the distillation teacher.
16. Every node carries a **verbatim source span + provenance + status**.
17. Three distinct status axes: epistemic (claim/hypothesis) · activity modality (proposed/in-progress/completed) · curation (AI-extracted → in review → expert-verified).

**Architecture**
18. **Other projects (PRSM, RRGI, Extract2) are inspiration / prior art only — NOT dependencies.** Build the core flow standalone, borrowing *techniques* (RRGI's OpenRouter+Mistral free-LLM calls; Extract2's Docling/chunking/dedup/eval patterns; PRSM's citation-depth model), reimplemented here. The only external artifact we consume is the **MIRA LinkML schema**. Our pipeline does discourse-content extraction plus **identity/affiliation/paper resolution via OpenAlex/ORCID directly** — into **one identity-stamped graph (no separate bibliometric sidecar)**; funder-side and proposer-side join on DOIs/ORCIDs/OpenAlex IDs.
19. Compliance gate = **quarantine** on uncertainty (valid file / text layer / expected doc type).
20. **API-first**: results served over an HTTP API (graph-LD); the UI is one client (RRGI AppView pattern).
21. Borrow Extract2's **patterns** (Docling ingest, offset-preserving chunking, dedup, eval, Docker, model-backend abstraction) — reimplemented here, not imported; use **LLM extraction**, not its encoder-NER model.
22. Schema = track current MIRA + validate against it; keep a deltas note; **don't** build hot-swap machinery. **Bind strictly to `main`** (pinned SHA `f7d0449`); **no proposal-branch classes** (R9) — our additions live in the `mirax:` overlay (the deltas).

**Added (2026-06-09, reconciled with SPEC v0.3)**
23. **Bundles are the grouping primitive.** Every document explodes into MIRA nodes that stay grouped in a `Bundle` (RRGI's model). A `Narrative` is an *optional* prose overlay that **references** a bundle — **not** a `Bundle` subtype, not on the v1 path.
24. **Relations are reified as nodes** (`mirax:Relation` + `relation_type`), canonical per MIRA's `sampleData.json`; each edge carries its own envelope.
25. **Identity uses ORCID/ROR now, DID-shaped placeholders otherwise** — upgrade path to real DIDs + ATProto publishing later; v1 leaves the seams (SPEC §8.4).

_The full revision rationale (R1–R9) is in **SPEC §19**; the complete model is **SPEC v0.3** + **V1-MODEL.md**._

## Deferred (decided: not now)

- Alignment algorithm + mission-alignment metric.
- Fine-tuned small/volunteer model (+ multi-agent as its quality tier).
- Deep prior-art expansion (our own, OpenAlex-based; PRSM's model as reference).
- **ATProto/DID publishing adapter** + **node claiming / attribution upgrade** (RRGI-style; v1 leaves the seams — SPEC §8.4).
- **Funder `Criterion` / `Grant` / `Project` modeling** (proposal-branch classes; revisit if needed, or when `proposals` merges into `main`).
- RRGI publishing of extracted graphs.
- Gold/eval set; no SciOS-portfolio dogfooding.
- PR our `mirax:` overlay deltas to MIRA — prototype + collect evidence first.
