# MIRA Extraction — Build Plan

_Created 2026-06-09._

A funder-facing pipeline that turns uploaded PDFs (mission/CFP, proposal, author profile, prior art) into
**MIRA-schema graph-LD**, and renders a 4-pane view that helps a funder decide whether/how a proposal
aligns with their mission.

The **PDF → MIRA objects** engine is the shared core; the funder app is its first consumer.

---

## Product flow

```
upload (1 pdf or a directory)
  → queue (process one at a time)
    → compliance gate (valid? text layer? expected doc type? else QUARANTINE)
      → route by doc type → extract (nodes + reified edges; grounded + status-tagged + author-stamped)
        → group into a Bundle → resolve identities (OpenAlex/ORCID: Agents + affiliatedWith)
          → validate against MIRA schema (+ mirax overlay)
            → link funder-side ↔ proposer-side → output one identity-stamped MIRA graph-LD (HTTP API)
              → 4-pane results page  (a client of that API)
```

---

## Locked decisions (don't relitigate)

| Topic | Decision |
|---|---|
| Output | MIRA **graph-LD** only |
| Model | Hosted **Claude / Mistral free tier** now; **swappable backend**; small fine-tuned/volunteer model later |
| Processing | One PDF at a time; directory upload builds a queue |
| Domain | All science |
| Compliance | **Quarantine** anything uncertain (don't drop, don't force-extract) |
| Identity | First-class **`Agent` identities** (researchers/orgs/funders; ORCID/ROR/DID), stamped as authors + related via `affiliatedWith`; **no human *discourse* nodes**. ORCID→OpenAlex = data source (no sidecar). No ORCID → skip. Curated/top-N pubs → **full extraction** (each a Bundle) |
| Mission + CFP | Extract to **Questions** (funder-side; Criteria dropped — proposal-branch only) |
| Grouping | Every document → a **`Bundle`** (the primitive); `Narrative` = optional prose overlay referencing a bundle (not a subtype) |
| Relations | **Reified as nodes** (`mirax:Relation` + `relation_type`); each edge carries its own envelope |
| Prior art | v1 = the proposal's **own reference list** only; depth-controlled expansion handed to **PRSM** later |
| Grounding | Every node carries a **verbatim source span**, **provenance**, and a **status** |
| Status axes (kept distinct) | epistemic (claim/hypothesis) · activity modality (proposed/in-progress/completed) · curation (AI-extracted → in review → expert-verified) |
| Schema | Bind **strictly to MIRA `main`** (pinned SHA) + validate; keep a **deltas note**; **no proposal-branch classes**; no hot-swap machinery |
| API | Results stored + **served over an HTTP API** (graph-LD); the web UI is just one client (RRGI AppView pattern) |

**Values to honor** (from the workshop sketch): open data sources first · advisory, not authoritative ·
white-box / transparent process · human-in-the-loop (computer-assisted human) · pluralistic evaluation.

---

## Architecture

**Other projects (PRSM, RRGI, Extract2) are inspiration only — NOT dependencies.** We build the core flow
standalone and borrow *techniques*, reimplemented here. The only external artifact we consume is the
**MIRA LinkML schema** (the output contract we validate against).

Our pipeline produces **one identity-stamped graph** (no separate bibliometric sidecar):

- **Discourse nodes** — Question / Claim / Evidence / Study / Protocol / Request / Argument /
  SourceDocument (MIRA `main`) + **reified relations**, extracted from the PDFs and grouped into **Bundles**.
- **Agent identities** — researchers / orgs / funders (ORCID / ROR / DID), stamped as authors (`creator`)
  and related via `affiliatedWith`. Populated from **OpenAlex / ORCID directly** (PRSM's depth-control
  model is the reference for shallow citation context, not a service we call).

Alignment is **graph connectivity**, not text similarity:

- **Funder-side** (mission + CFP) → **Questions** (+ the funder Agent).
- **Proposer-side** (proposal + curated pubs + references) → the proposal Bundle + the proposer's
  authored-paper Bundles + a prior-art Bundle, all stamped with the proposer's identity.
- **Alignment** = proposal Claims `address` mission Questions (**primary**) · prior-art overlap
  (DOI/OpenAlex dedup) · shared identities. (Metric deferred.)

---

## Components to build

1. **Web app + queue** — upload a PDF or a directory; build a queue; process one at a time; show job status.
2. **Compliance gate** — per PDF: valid file, real text layer, expected doc type; quarantine on low
   confidence; emit a per-file report.
3. **Core extraction engine** — `chunk of text → MIRA objects`, validated against the MIRA schema.
   - **Docling ingest** + **offset-preserving chunker** + dedup/merge (our own, following Extract2's patterns).
   - **Swappable model backend** behind one interface (hosted LLM now, fine-tuned model later).
   - Every node/edge: **verbatim source span + provenance + status + author identity** (`creator`).
   - Each document grouped into a **`Bundle`**; relations **reified** as nodes.
4. **Document-type extractors** (variants on the engine):
   - **Proposal** → Q/C/E/Study + the **proposed work** + a **preliminary-results (WIP) subgraph** (sub-bundles).
   - **Mission + CFP** → Questions (funder-side).
   - **Author profile** → ORCID → OpenAlex **identity resolution** (Agent nodes + `affiliatedWith`); curated/top-N pubs → full extraction (each a Bundle). Collaboration/standing = read-time lenses.
   - **Prior art** → the proposal's reference list (scoped to what's cited) → a prior-art Bundle.
5. **Linking step** — connect funder-side ↔ proposer-side on shared Questions, DOIs, identities (+ bundle↔bundle).
6. **Output + API** — store each result as MIRA **graph-LD** and serve it over an **HTTP API** (list
   submissions, get a document's graph, get the linked submission graph, get a node, get the compliance
   report). **API-first: the UI is just one client** (RRGI AppView pattern), so PRSM, the alignment
   algorithm, and other consumers read the same endpoints.
7. **4-pane results page (API client)** — (1) collaboration standing, (2) what the proposal proposes, (3) ecosystem
   relation (adjustable granularity), (4) mission alignment. Includes a **"How this works"** tab (white-box).
8. **MIRA schema-deltas note** — running list of gaps we hit, to propose upstream later.

---

## Phases (dependency-ordered; thin slice first)

**Phase 0 — Skeleton.** Repo + engine interface; Docling ingest; single-agent LLM extraction of **one** doc
type; schema-validate; dump graph-LD. _Done when: one real PDF → valid MIRA graph-LD end to end._

**Phase 1 — Core engine.** Offset-preserving chunker; grounding + provenance + status on every node;
model-backend abstraction; schema validation + deltas log. _Done when: the engine is the stable, swappable core._

**Phase 2 — Front door.** Upload (single + directory); doc-type classify + route + quarantine; one-at-a-time
queue; job status. _Done when: a user can upload and watch papers process._

**Phase 3 — Doc-type extractors + identity layer.** Proposal (WIP + proposed-work sub-bundles), mission/CFP
(Questions), author profile (ORCID→OpenAlex Agents + `affiliatedWith`; top-N pubs → Bundles), prior art
(reference list → prior-art Bundle); collaboration/standing lenses. _Done when: each input type yields its
Bundle; identities populate._

**Phase 4 — Linking.** Join funder-side ↔ proposer-side (Questions/DOIs/identities/bundle↔bundle). _Done when: shared Questions/DOIs/identities connect the graphs._

**Phase 4b — API surface.** Serve results as graph-LD over HTTP (submissions, document graph, linked
submission graph, node, compliance report). _Done when: any result is pullable programmatically._

**Phase 5 — 4-pane UI (API client).** Render panes 1–3 by consuming the API; pane 4 = placeholder. _Done when: a funder sees the results page._

---

## Inspiration map (techniques to reimplement — NOT dependencies)

| Source | Technique we borrow (reimplemented here) |
|---|---|
| **MIRA schema** | The actual output contract + validator (LinkML → Pydantic/JSON Schema). *This one we consume directly.* |
| **Extract2** | Docling ingest, offset-preserving chunking, dedup/merge, eval harness, Docker/batch, model-backend abstraction. (LLM extraction, not its encoder-NER model.) |
| **RRGI** | Free-LLM calls (OpenRouter + Mistral + fallback chain); grounding/provenance patterns; API-first (AppView). |
| **PRSM** | Citation-depth model (citation_level, discovery_source, foundational deferral) for our own OpenAlex-based lookups. |
| **eLife-claim-trees / language-health** | LLM-draft + human-verify; verbatim grounding; curation lifecycle. |

---

## Deferred (not now)

- The alignment **algorithm** and the **mission-alignment metric** itself (the workshop "metric development":
  alignment / impact / potential / trust / value / risk / excellence).
- **Fine-tuned small / volunteer model** (+ multi-agent reconciliation as its quality tier / distillation teacher).
- **Deep prior-art expansion** (our own, OpenAlex-based; PRSM's model as reference).
- **RRGI publishing** of extracted graphs.
- **Retroactive** corpus extraction (the sketch's path 2b); we build the **proactive** proposal path (2a) first.

---

## Open (resolve while building, not blockers)

- **Resolved in SPEC v0.3:** stack (Python/FastAPI + worker + SQLite/blobs + Next.js) and the LLM
  provider chain (OpenRouter free → fallback; paid opt-in). See SPEC §2, §4.4.
- Extraction unit / granularity for proposals (settle empirically once the engine runs — eval A/B).
- Open items **O1–O3** (OCR policy, OpenAlex API key, minted-id scheme) — SPEC §19.

---

## MIRA schema deltas (running list — the `mirax:` overlay diff; propose upstream later)

- **Verbatim source span** + **provenance** on every node/edge (MIRA `main` has neither).
- **Three status axes** as enums: epistemic · activity-modality (proposed/in-progress/completed) · curation.
- **Identity as authorship:** widen `creator` → `Agent`; `Agent` identifier slots; **`affiliatedWith`** (Agent→Agent).
- **`Bundle`** grouping (+ optional `Narrative` overlay) with `{ref, content_hash}` members.
- **Slot-attachment fixes** so closed validation accepts our output (attach `addresses`/`supports`/… to their classes).
- **Reified-relation class** (`mirax:Relation`) — MIRA has no per-relation classes to validate against.
- (Considered, **not** adopted: the proposal-branch funder-side classes — Criterion/Endorsement/Project/Grant.)
