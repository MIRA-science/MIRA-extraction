# MIRA-extraction — Technical Specification (SPEC)

_Version 0.3 · 2026-06-09 · hand-to-developer build spec._

This document is the buildable specification for **MIRA-extraction**: a funder-facing pipeline that
turns uploaded scientific PDFs into **MIRA-schema graph-LD** and renders a **4-pane funding-decision
view**. The **PDF → MIRA objects** extraction engine is the shared core; the funder app is its first
consumer.

It is authored to be implemented from directly. It is consistent with `DECISIONS.md` and
`BUILD-PLAN.md` except where it **explicitly revises a decision** (search **DECISION-REVISION**) or
resolves a previously-open item (search **DECISION-NOTE**). Open questions for the owner are in
[§19](#19-open-questions-for-the-owner).

> **Framing (do not violate).** PRSM, RRGI, and Extract2 are **inspiration / prior art only — not
> dependencies**. We build the core flow standalone and borrow *techniques*, reimplemented here. The
> **only external artifact we consume is the MIRA LinkML schema**, which we validate against. All
> identity/affiliation/paper data is sourced from **OpenAlex / ORCID directly**.

### Changelog — v0.3 (2026-06-09)

- **Bind strictly to MIRA `main`.** Dropped the proposal-branch classes (`Criterion`, `Endorsement`,
  `Project`, `Grant` + `endorsed`/`funder`/`scope`). The overlay is now `main` **+ our own generic
  extensions only** (envelope, identity, bundles, reified relations) — zero proposal-branch classes.
  **Mission/CFP → Questions only** (revises Decision 8's "Questions + Criteria"); funder eligibility/
  priorities can ride along as prose in the mission bundle, no class needed.
- **Bundle is the grouping primitive; Narrative is demoted** to an *optional* prose overlay that
  *references* a bundle (`over_bundle`) — it is **not** a `Bundle` subtype (per RRGI's seed note: "a
  narrative is formed out of one or more bundles"). v1 may not produce narratives at all.

### Changelog — what changed from v0.1 (the model shift)

v0.1 treated author/collaboration data as a **separate non-MIRA "bibliometric sidecar"** and read
Decision 9 as "no human nodes at all." Owner review (2026-06-09, grounded in how RRGI handles identity
and bundles) corrected this. v0.2 adopts a **single identity-stamped graph**:

- **Identity layer.** Researchers, organizations, funders, and users are first-class **`Agent`
  identities** (ORCID / ROR / minted-DID-later), **stamped as the author (`creator`) of every node and
  bundle** they produce, and **related to each other in-graph** via `affiliatedWith` (person↔org).
  Humans are *not discourse nodes* — they are the **identity behind** the
  nodes they author (RRGI's DID model; we use ORCID now). **This revises Decision 9** (see
  [§8](#8-identity-layer-authorship-affiliation-collaboration)).
- **Bundles are the grouping primitive.** Every document **explodes into discourse nodes that stay
  grouped in a `Bundle`**, exactly as RRGI groups a paper's nodes. A `Narrative` is an *optional* prose
  overlay that **references** a bundle (not a `Bundle` subtype). Bundles nest; a node may belong to many.
  (See [§4.9](#49-bundles--narratives-grouping).)
- **No sidecar.** OpenAlex/ORCID become a **data source** that populates identity nodes, `affiliatedWith`
  edges, paper discovery, and DOIs/full-text. **Collaboration, affiliation, and standing are in-graph
  edges + read-time lenses**, not a parallel graph. (Rewritten [§8](#8-identity-layer-authorship-affiliation-collaboration).)
- **Relations are reified as nodes** (canonical, decided by MIRA's own `sampleData.json`).

---

## Table of contents

0. [Glossary](#0-glossary)
1. [System overview & the core flow](#1-system-overview--the-core-flow)
2. [Tech stack, repo layout, runtime topology](#2-tech-stack-repo-layout-runtime-topology)
3. [Data model & storage](#3-data-model--storage)
4. [Core extraction engine](#4-core-extraction-engine) — `text → MIRA objects`, bundles, identity stamping
5. [Schema binding](#5-schema-binding) — LinkML → Pydantic/JSON-Schema, the extension overlay, deltas
6. [Compliance / quarantine gate](#6-compliance--quarantine-gate)
7. [Doc-type routing & per-doc-type extractors](#7-doc-type-routing--per-doc-type-extractors)
8. [Identity layer: authorship, affiliation, collaboration](#8-identity-layer-authorship-affiliation-collaboration) (OpenAlex / ORCID)
9. [Linking funder-side ↔ proposer-side](#9-linking-funder-side--proposer-side)
10. [Output: MIRA graph-LD format](#10-output-mira-graph-ld-format)
11. [HTTP API](#11-http-api-api-first)
12. [4-pane UI](#12-4-pane-ui-an-api-client)
13. [Reproducibility of a run](#13-reproducibility-of-a-run)
14. [Testing & evaluation](#14-testing--evaluation)
15. [Configuration & secrets](#15-configuration--secrets)
16. [Phases & milestones](#16-phases--milestones)
17. [Schema-deltas (running list)](#17-schema-deltas-running-list)
18. [Deferred (explicitly not now)](#18-deferred-explicitly-not-now)
19. [Open questions for the owner](#19-open-questions-for-the-owner)
- [Appendix A — Pinned external facts](#appendix-a--pinned-external-facts-verified-2026-06-09)
- [Appendix B — Example end-to-end payloads](#appendix-b--example-end-to-end-payloads)

---

## 0. Glossary

| Term | Meaning |
|---|---|
| **MIRA schema** | The LinkML schema at `github.com/MIRA-science/schema`. The output contract. |
| **graph-LD** | JSON-LD graph (`{"@context": [...], "@graph": [...]}`) that validates against MIRA. |
| **Discourse node** | A MIRA `main` node about the science: `Question`, `Claim`, `Evidence`, `Study`, `Protocol`, `Request`, `Argument`, `SourceDocument`. |
| **Agent / Identity node** | A first-class actor: `Agent` (= `foaf:Agent`) representing a **researcher, organization, funder, or user**, identified by **ORCID / ROR / DID** (minted placeholder now). Authors discourse nodes; relates to other agents. **Not** a discourse node. |
| **Relation / edge** | A typed link between nodes (e.g. `addresses`, `supports`, `affiliatedWith`). **Reified as nodes** (`mirax:Relation`, MIRA convention); each edge carries its own envelope. |
| **Bundle** | A node that names a **flat, unordered set of members** (discourse nodes, edges, or other bundles). One bundle per ingested document keeps its exploded nodes grouped. Borrowed from RRGI; reimplemented as `mirax:Bundle`. |
| **Narrative** | *Optional, de-emphasized.* A thin prose overlay written **over** a bundle (references it via `over_bundle`) — **not** a `Bundle` subtype. Bundles are what matter; narratives are not on the v1 critical path. |
| **Envelope** | Per-node/edge metadata MIRA lacks: **verbatim source span + provenance + 3 status axes + author identity**. Carried in the `mirax:` extension namespace. |
| **Collaboration lens** | A **derived, read-time** projection: two agents collaborate if they co-author the same bundle/connected nodes. Not stored, not imported. |
| **Funder-side graph** | The mission/CFP bundle: **Questions** (+ the funder `Agent`). |
| **Proposer-side graph** | The proposal bundle (proposed work + WIP) + the proposer's authored-paper bundles + prior-art bundle, all stamped with the proposer's identity. |
| **Submission** | One funder decision unit: a mission(+CFP) + a proposal (+ proposer ORCID + curated/top pubs + references). |
| **Document** | One ingested PDF (or one resolved external work) within a submission → one `Bundle`. |
| **Run** | One full pipeline execution over a document/submission, captured by a reproducible manifest. |
| **Backend** | A swappable LLM provider adapter (OpenRouter / Mistral / Anthropic). |

---

## 1. System overview & the core flow

```
upload (1 pdf or a directory / zip)
  → queue (process one document at a time, FIFO)
    → compliance gate (valid file? real text layer? expected doc type? else QUARANTINE)
      → route by doc type
        → extract (chunk → LLM → MIRA discourse nodes + reified edges,
                   each grounded + provenanced + status-tagged + STAMPED with an author identity)
          → wrap the document's nodes/edges in a BUNDLE (optional NARRATIVE overlay if prose kept)
            → resolve identities & discover/extract authored papers (OpenAlex/ORCID)
               · create Agent nodes (researcher/org/funder) + affiliatedWith edges
            → validate against MIRA schema (+ extension overlay)
              → link funder-side ↔ proposer-side  (shared Questions / DOIs / identities;
                                                    bundle↔bundle relations)
                → store + serve one identity-stamped MIRA graph-LD over an HTTP API
                  → 4-pane results page (a client of that API);
                     collaboration & standing are read-time LENSES over the graph
```

**Honored values** (workshop): open data first · advisory not authoritative · white-box · human-in-the-
loop · pluralistic. Concretely: open APIs (OpenAlex/ORCID); no automated fund/reject verdict (pane 4 is
a scaffold); every node/edge exposes its source span + author + model + prompt + confidence ("How this
works" tab); a curation lifecycle; status as three independent axes, not one score; and **curation/
standing/collaboration are swappable read-time lenses** over a shared graph (RRGI's AppView pattern),
so anyone can compute a different view.

**In scope:** everything up to the linked, identity-stamped graph-LD + API + panes 1–3, with pane 4 and
the alignment **metric** as an explicit placeholder. **Deferred** items in [§18](#18-deferred-explicitly-not-now).

---

## 2. Tech stack, repo layout, runtime topology

### 2.1 Stack (resolves the BUILD-PLAN "open" stack item)

**DECISION-NOTE:** stack pinned as below.

| Layer | Choice | Notes |
|---|---|---|
| Language (core) | **Python 3.12** | Docling supports 3.10–3.14; upstream LinkML supports it. (MIRA's repo pins Python 3.14 + a LinkML fork **only to regenerate its own artifacts** — not needed to consume/validate.) |
| Ingest | **Docling 2.99.x** (`docling`, `docling-core`, `docling-parse` pinned together) | PDF → `DoclingDocument` with per-item page/bbox/charspan provenance. |
| Extraction LLM | **OpenRouter free models (incl. Mistral) → fallback chain**; swappable to Mistral-native / Anthropic | [§4.4](#44-swappable-llm-backend--fallback-chain). |
| Schema tooling | **LinkML** (upstream PyPI): `gen-pydantic`, `gen-json-schema`, `gen-jsonld-context`, `linkml-validate` | [§5](#5-schema-binding). |
| API | **FastAPI + Uvicorn** | API-first; OpenAPI auto-doc. |
| Queue/worker | **DB-backed FIFO job table + a single worker process** (concurrency = 1) | "One PDF at a time" (Decision 3). |
| Metadata store | **SQLite** via SQLAlchemy/SQLModel (`data/mira.db`) | Submissions, documents, jobs, runs, agents, node/bundle indexes, curation. Swappable to Postgres. |
| Blob store | **Content-addressed filesystem** under `data/blobs/<sha256>` | PDFs, Docling JSON, chunks, raw completions, graph-LD, reports, manifests, HTTP caches. |
| HTTP client | `httpx` (async) | OpenAlex/ORCID + LLM calls; retry/backoff. |
| Front end | **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui** | Pure API client. Graph viz via **Cytoscape.js** (or `react-force-graph`). |
| Packaging | **Docker Compose** (`api`, `worker`, `web`) + a Docling model-prefetch build step | One-command bring-up. |
| Tests | **pytest** (Python), **Playwright** (UI smoke) | [§14](#14-testing--evaluation). |

### 2.2 Repo layout

```
MIRA-extraction/
├─ SPEC.md  DECISIONS.md  BUILD-PLAN.md  README.md
├─ pyproject.toml  uv.lock
├─ docker-compose.yml  Dockerfile.api  Dockerfile.worker  Dockerfile.web
├─ .env.example
├─ schema/
│  ├─ vendor/                                   # pinned MIRA-science/schema @ SHA (§5.1) + import closure
│  │  └─ SOURCE.txt                             # commit SHA + branch + fetch date
│  ├─ mira_x.yaml                               # OUR overlay: envelope, status enums, Bundle (+optional
│  │                                            #   Narrative overlay), Agent identity slots, affiliatedWith
│  ├─ generated/  (gitignored)                  # mira_models.py, mira.schema.json, mira.context.jsonld
│  └─ Makefile                                  # `make schema`
├─ src/mira_extraction/
│  ├─ config.py
│  ├─ ingest/        docling_ingest.py  textlayer.py
│  ├─ chunking/      chunker.py
│  ├─ engine/
│  │  ├─ interface.py     # Extractor protocol, Chunk, ExtractionResult, Envelope, ExtractedNode/Edge
│  │  ├─ extractor.py     # generic chunk -> MIRA objects
│  │  ├─ grounding.py     # verbatim source-span verification
│  │  ├─ dedup.py         # cross-chunk dedup/merge
│  │  ├─ bundles.py       # assemble a document's nodes/edges into a Bundle (+ optional Narrative overlay)
│  │  ├─ identity.py      # Agent creation + authorship stamping
│  │  ├─ provenance.py    # provenance + run-manifest helpers
│  │  └─ status.py        # the three status-axis enums + assignment rules
│  ├─ backends/     base.py openrouter.py mistral.py anthropic.py chain.py cache.py
│  ├─ doctypes/     classify.py proposal.py mission_cfp.py author_profile.py prior_art.py
│  ├─ identity/     orcid.py openalex.py resolve.py   # API clients + identity resolution
│  ├─ lenses/       collaboration.py standing.py       # derived read-time lenses
│  ├─ linking/      linker.py
│  ├─ schema_binding/  loader.py validate.py serialize.py
│  ├─ compliance/   gate.py
│  ├─ pipeline/     run.py
│  ├─ queue/        worker.py
│  ├─ storage/      db.py models.py blobs.py
│  └─ api/          app.py routers/*.py schemas.py
├─ web/             app/ components/ lib/api.ts ...
├─ eval/            fixtures/ harness.py metrics.py reports/
└─ tests/
```

### 2.3 Runtime topology

Three Compose services sharing `data/` + the SQLite DB: **`api`** (FastAPI; enqueues, serves, never
does heavy work inline), **`worker`** (single process, concurrency 1; polls `jobs`, runs the pipeline),
**`web`** (Next.js; talks only to `api`). Docling models baked into the `worker` image.

---

## 3. Data model & storage

### 3.1 Relational tables (SQLite)

UUIDv4 string IDs unless noted; UTC ISO-8601 timestamps.

**`submissions`** — one funder decision unit.
| col | type | notes |
|---|---|---|
| id | str pk | |
| title | str | funder label |
| funder_agent_id | str? | the funder identity (minted DID-shaped id or provided) |
| proposer_orcid | str? | proposer's ORCID (entered or extracted, §7.3) |
| curated_pub_dois | json | optional DOIs the proposer flagged as "top" |
| status | enum | `open`,`processing`,`complete`,`partial`,`error` |
| created_at / updated_at | ts | |

**`documents`** — one ingested PDF (or one resolved external work) → one Bundle.
| col | type | notes |
|---|---|---|
| id | str pk | |
| submission_id | str fk | |
| role | enum | `mission`,`cfp`,`proposal`,`curated_pub`,`prior_art`,`unknown` |
| origin | enum | `upload`,`openalex`,`orcid` |
| filename / blob_sha | str? | source PDF (content-addressed) |
| doi / openalex_id | str? | for external-origin docs |
| detected_doctype / doctype_confidence | enum/float | classifier output (§7.1) |
| compliance_status | enum | `pass`,`quarantine`,`error` |
| bundle_node_id | str? | the document's Bundle `@id` |
| graph_blob_sha | str? | the document's graph-LD artifact |
| latest_run_id | str fk? | |
| created_at / updated_at | ts | |

**`agents`** — identity registry (researchers, orgs, funders, users).
| col | type | notes |
|---|---|---|
| id | str pk | the Agent `@id` (CURIE), e.g. `orcid:0000-...`, `ror:01abc...`, `did:mira:<uuid>` |
| kind | enum | `researcher`,`organization`,`funder`,`user`,`entity` |
| id_scheme | enum | `orcid`,`ror`,`openalex`,`did`,`minted` |
| display_name | str | |
| external_ids | json | {orcid, ror, openalex, doi-prefix, ...} |
| metadata | json | OpenAlex summary_stats (h_index, works_count), country, etc. |
| created_at | ts | |

**`jobs`** — the FIFO queue.
| id, document_id fk, kind(`ingest_extract`/`identity_resolve`/`link`), state(`queued`/`running`/`done`/`failed`/`quarantined`), attempts, error, claimed_at, finished_at, created_at |

**`runs`** — reproducibility manifests ([§13](#13-reproducibility-of-a-run)).
| id, document_id/submission_id fk, manifest_blob_sha, schema_sha, created_at |

**`node_index`** — flat index of every emitted node/edge/bundle/agent for `GET /nodes/{id}` + curation.
| id (the `@id`), document_id fk, node_type (`mira:Claim`,`mira:addresses`,`mirax:Bundle`,`mira:Agent`,…), label, creator_agent_id, curation_status, content_hash (sha256 of canonical JSON — the "version seal"), envelope_blob_sha, superseded_by |

**`bundle_members`** — RRGI-style reverse index ("which bundles contain X"); one row per `(bundle, member)`.
| bundle_id fk, member_id, member_content_hash, member_type, ord, primary key (bundle_id, member_id) |

**`curation_events`** — append-only human-in-the-loop log.
| id, node_id, document_id, actor, action(`verify`/`reject`/`edit`/`merge`/`split`), before_json, after_json, note, created_at |

**`http_cache`** — OpenAlex/ORCID/LLM response cache (mirrored to blobs); key = sha256 of canonical request.

### 3.2 Blob store

`data/blobs/<sha256[:2]>/<sha256>` + `.meta.json`. Artifacts: PDFs; `docling.json`; `ingest.json`
(offset stream, §4.2); `chunks.json`; raw LLM completions; `graph.jsonld`; `compliance.json`;
`manifest.json`. Content-addressed → identical re-runs are cache hits. **`content_hash`** (sha256 of a
node's canonical JSON) is the prototype stand-in for RRGI's CID seal in bundle membership — see
[§4.9](#49-bundles--narratives-grouping).

---

## 4. Core extraction engine

The centerpiece (Decision 12): a **measured** `text → MIRA objects` process with a swappable LLM
backend, offset-preserving chunking, verbatim grounding, provenance, three status axes, **author-
identity stamping**, and **bundle assembly**.

### 4.1 The `text → MIRA objects` interface

```python
# src/mira_extraction/engine/interface.py  (illustrative; pin exact fields in code)

class SourceSpan(BaseModel):
    quote: str; doc_id: str; char_start: int; char_end: int
    page: int | None; bbox: tuple[float,float,float,float] | None
    grounding: Literal["verified","fuzzy","unverified"]            # §4.6

class Provenance(BaseModel):
    run_id: str; backend: str; model: str; fallback_path: list[str]
    prompt_id: str; prompt_sha: str; schema_sha: str; chunk_id: str
    extracted_at: str; confidence: float; raw_completion_sha: str
    was_generated_by: Literal["aiAssistedExtraction","aiSuggested","manualAuthoring","importedFromSource"]

class Status(BaseModel):
    epistemic: EpistemicStatus                       # claim|hypothesis|assumption|definition|observation
    activity_modality: ActivityModality | None        # proposed|in_progress|completed (Activity nodes)
    curation: CurationStatus                          # ai_extracted|in_review|expert_verified|rejected

class Envelope(BaseModel):                            # on every node AND every edge
    source_span: SourceSpan
    provenance: Provenance
    status: Status
    creator: str | None                              # author Agent @id (the identity BEHIND the node) — §4.10

class ExtractedNode(BaseModel):
    local_id: str; type: str                         # MIRA class CURIE, e.g. "mira:Claim"
    title: str | None; description: str | None
    slots: dict[str, Any]                            # additional literal-valued MIRA slots
    envelope: Envelope

class ExtractedEdge(BaseModel):
    local_id: str; type: str                         # MIRA relation CURIE, e.g. "mira:addresses"
    source: str; target: str                         # local_ids
    envelope: Envelope

class ExtractionResult(BaseModel):
    nodes: list[ExtractedNode]; edges: list[ExtractedEdge]; chunk_id: str; warnings: list[str]

class Chunk(BaseModel):
    chunk_id: str; doc_id: str; text: str; char_start: int; char_end: int
    pages: list[int]; section_path: list[str]; records: list[OffsetRecord]   # §4.2

class DocContext(BaseModel):
    doc_id: str; role: str; title: str | None; section_path: list[str]
    author_agents: list[str]                         # candidate author Agent @ids for this document — §4.10
    prior_nodes_digest: list[NodeDigest]             # already-extracted nodes (linking/dedup)

class Extractor(Protocol):
    def extract(self, chunk: Chunk, ctx: DocContext, *, binding: SchemaBinding,
                backend: LLMBackend) -> ExtractionResult: ...
```

The **generic extractor** is doc-type-agnostic; `doctypes/` modules supply the prompt template + target
node/edge whitelist + post-processing. One engine, several configured extractors.

### 4.2 Ingest (Docling)

`ingest/docling_ingest.py`:
1. `DocumentConverter().convert(pdf_path)`; quarantine on `status not in {SUCCESS, PARTIAL_SUCCESS}` ([§6](#6-compliance--quarantine-gate)).
2. Persist `result.document.export_to_dict()` → `docling.json`.
3. **Build the text stream + offset records ourselves** — Docling's `charspan` is **per-item, not a
   global offset**. Walk `doc.iterate_items()`; for each item with `.text`, append to a buffer and record:
   ```python
   class OffsetRecord(BaseModel):
       text: str; char_start: int; char_end: int   # offsets into OUR assembled stream
       page: int | None; bbox: tuple | None          # normalized TOPLEFT via bbox.to_top_left_origin(h)
       label: str; section_path: list[str]
   ```
   Fixed joiner (`"\n"`). Persist `ingest.json`. This is the offset-preserving guarantee: every span
   maps back to (page, bbox) + an exact source substring.
4. Tables → `export_to_markdown()`/`export_to_dataframe()`; figures → `PictureItem.caption_text(doc)`;
   both become labeled offset records. Image bytes not needed for v1.

**DECISION-NOTE:** OCR off by default (`do_ocr=False`); scanned pages are **quarantined**, not silently
OCR'd. `INGEST_OCR_FALLBACK=true` re-runs quarantined-as-scanned docs with `do_ocr=True,
force_full_page_ocr=True`. (Open question O1.)

### 4.3 Offset-preserving chunker

`chunking/chunker.py`. Input = ordered `OffsetRecord`s; output = `Chunk`s.
- Token-budgeted windows that **respect section/paragraph boundaries**; default `max_tokens=1200`,
  `overlap_tokens=150`. Never split inside an `OffsetRecord`.
- Each chunk carries `char_start/char_end`, `pages`, `section_path`.
- Overlap ensures cross-boundary claims are seen twice; dedup ([§4.7](#47-dedupmerge)) reconciles.
- **DECISION-NOTE:** we keep our own record-based chunker (not Docling's `HybridChunker`) precisely
  because `charspan` isn't a stream offset; we may use `HybridChunker` later for retrieval, not for
  grounding. Granularity (`max_tokens`/`overlap`, window-vs-section) is tuned empirically by eval
  (Decision 14).

### 4.4 Swappable LLM backend & fallback chain

`backends/`. One interface, three adapters, one chain (RRGI's free-LLM technique, reimplemented).

```python
class LLMRequest(BaseModel):
    messages: list[dict]; json_schema: dict | None; max_tokens: int = 4096; extra: dict = {}
class LLMResponse(BaseModel):
    text: str; parsed: dict | None; model: str; usage: dict | None; raw_sha: str
class LLMError(Exception): ...
class Retryable(LLMError): ...        # 429/5xx/timeout
class Fatal(LLMError): ...            # 402/auth/model-not-found
class SchemaUnsupported(LLMError): ...
class LLMBackend(Protocol):
    name: str
    def complete(self, req: LLMRequest, model: str) -> LLMResponse: ...
```

**Adapters** — `OpenRouterBackend` (`https://openrouter.ai/api/v1`, OpenAI-compatible; headers
`Authorization`/`HTTP-Referer`/`X-Title`; **discovers free models at runtime** via `GET /api/v1/models`
filtering `pricing.prompt=="0" && pricing.completion=="0"` ∩ `supported_parameters`; sends
`response_format:{type:"json_schema",json_schema:{strict:true,…}}` + `provider:{require_parameters:
true}`); `MistralBackend` (`https://api.mistral.ai/v1`); `AnthropicBackend` (`/v1/messages`,
`x-api-key`, `anthropic-version: 2023-06-01`, `output_config.format`; **Opus 4.8/4.7 reject
`temperature`/`top_p`/`top_k`** → use `thinking:{type:"adaptive"}` + `output_config.effort`; content is
a block array).

**FallbackChain** — ordered `(backend, model)` steps: (1) OpenRouter free model A (a Mistral `:free`,
discovered — **don't hardcode**); (2) OpenRouter free model B (different family); (3) OpenRouter
`models[]` server-side fallback array; (4) configurable paid escalation (Mistral-native → Anthropic
`haiku`→`sonnet`) when `LLM_ALLOW_PAID=true`. `Retryable`→backoff+jitter (max 3) then advance;
`SchemaUnsupported`→JSON-mode ladder once then advance; `Fatal`→skip. Circuit breaker + token-bucket
limiter (free limits ≈20 req/min; 50/day, or 1000/day after one-time $10).

**Structured-output ladder** per call: (1) `json_schema` strict + `require_parameters`; (2) on
`SchemaUnsupported`, `response_format:{type:"json_object"}` + schema in prompt; (3) parse → strip
fences/extract `{...}`/`json_repair`; (4) validate (Pydantic) → one repair retry feeding the error
back. All attempts recorded in `Provenance.fallback_path`.

**Completion cache** — key `sha256(model + json_schema + messages)`; hit ⇒ no network call (cheap,
deterministic eval/replay).

### 4.5 Extraction strategy (staged vs joint — empirical)

Config flag (Decision 14): **joint** (default; nodes+edges in one call) or **staged** (nodes, then
edges). Both yield `ExtractionResult`; the eval harness A/Bs them. Per item the LLM returns `type`
(restricted to the doc-type whitelist), `title`, `description`, the **verbatim `quote`**, `epistemic`
(+`activity_modality` for activities), `confidence`, and for edges `source`/`target`/`type`. Prompts in
`doctypes/*.py`, versioned (`prompt_id`+`prompt_sha`).

### 4.6 Grounding (verbatim source spans)

`engine/grounding.py`. Every node/edge carries a `quote`, verified against the chunk text: **exact** →
`verified` (offsets located, page/bbox from covering records); **fuzzy** (whitespace/ligature-normalized,
`rapidfuzz` ≥ 0.92) → `fuzzy` (confidence reduced); **no match** → `unverified` (kept, flagged,
confidence penalized, routed to `curation=in_review` — never silently dropped). Unverified rate is an
eval metric. Enables click-through source highlighting in "How this works."

### 4.7 Dedup/merge

`engine/dedup.py`. **Nodes:** same `type`, title/description `rapidfuzz` ≥ 0.90 + span overlap → merge
(keep one `local_id`, **union source spans**, highest-confidence provenance, union slots). Cross-document
merge allowed only for `SourceDocument` (by DOI) and `Agent` (by ORCID/ROR). **Edges:** dedup by
`(type, source, target)` post node-merge. Merges recorded (UI shows "extracted 3×, merged"). No silent loss.

### 4.8 The three status axes (kept distinct — Decision 17)

Enums in the overlay ([§5.2](#52-the-mirax-extension-overlay)); assigned in `engine/status.py`:

| Axis | Enum | Values | Assigned by |
|---|---|---|---|
| **Epistemic** | `EpistemicStatus` | `hypothesis`,`claim`,`assumption`,`definition`,`observation` | LLM + cue rules |
| **Activity modality** | `ActivityModality` | `proposed`,`in_progress`,`completed` | section + tense cues; `Study`/`Protocol`/`Project` only; drives proposed-vs-WIP split (§7.2) |
| **Curation** | `CurationStatus` | `ai_extracted`,`in_review`,`expert_verified`,`rejected` | pipeline sets `ai_extracted` (or `in_review` if grounding unverified/low conf); humans advance via the curation API |

Three independent fields, never collapsed into one score.

### 4.9 Bundles & narratives (grouping)

`engine/bundles.py`. After a document's nodes/edges are extracted, deduped, and validated, they are
**grouped into a `Bundle`** — borrowed from RRGI's model, reimplemented as `mirax:Bundle` /
`mirax:Narrative` (defined in the overlay, [§5.2](#52-the-mirax-extension-overlay)).

- **A `Bundle`** is a node naming a **flat, unordered set of members** — each member a reference to a
  discourse node, an edge, or **another bundle** (recursive). It carries `name`, `members[]`, `creator`
  (author identity), `provenance`, `createdAt`.
- **Member reference shape** (the prototype of RRGI's dual-addressed `strongRef {uri, cid}`):
  `{ "ref": "<member @id>", "content_hash": "sha256:…" }`. `ref` is the URI-role; `content_hash` is the
  CID-role (the exact version seal). When we later add an IPLD/AT-Proto layer, `ref`→`at://` URI and
  `content_hash`→CID with no model change.
- **A `Narrative`** is *optional and de-emphasized* — a thin prose overlay that **references** a bundle
  via `over_bundle` (+ `references[]`/`abstract`). It is **not** a `Bundle` subtype and **not** on the
  v1 critical path: bundles carry the structure; a narrative merely layers prose on top. v1 may skip it.
- **Grouping is one-directional** (the bundle lists members; nodes carry no back-pointer). Reverse
  lookup ("which bundles contain X") is the derived `bundle_members` index ([§3.1](#31-relational-tables-sqlite)).
- **A node may belong to many bundles; bundles nest.** This is how the proposal's **proposed-work** and
  **preliminary-results (WIP)** subgraphs are modeled: each is a **sub-bundle** (a member that is itself
  a bundle) within the proposal **bundle**, *and* its nodes carry the orthogonal `activity_modality` tag
  (grouping vs classification are independent).

Per-document output: one `Bundle` (the document's grouping) holding its nodes / edges / sub-bundles.
Every member is stamped with the document's author identity ([§4.10](#410-identity-stamping-authorship)).
If the document's prose is retained, an optional `Narrative` overlay references that bundle.

### 4.10 Identity stamping (authorship)

`engine/identity.py`. **Every node, edge, and bundle is stamped with an author `Agent` identity** — the
"identity behind the node" (RRGI's DID role; we use ORCID/ROR/minted-DID). See
[§8](#8-identity-layer-authorship-affiliation-collaboration) for how identities are created/resolved.

- `Envelope.creator` = the author Agent `@id` (the **human/org behind the content**), distinct from
  `provenance.was_generated_by = aiAssistedExtraction` (the **system that extracted it**). This mirrors
  RRGI's `wasAttributedTo` (who) vs `wasGeneratedBy` (how) and keeps the pipeline white-box: a node is
  *attributed to* the paper's author but *was generated by* our model.
- Stamping source by doc role: **proposal** → the proposer Agent (proposer ORCID); **authored paper /
  curated pub** → that paper's author Agents (ORCIDs from OpenAlex `authorships[]`); **mission/CFP** →
  the funder Agent. Co-authors and institutions become Agent nodes + `affiliatedWith` edges
  ([§8](#8-identity-layer-authorship-affiliation-collaboration)).
- Humans/orgs are **never discourse nodes** — they are `Agent` identity nodes referenced by `creator`
  and related via `affiliatedWith`. (**This is the Decision-9 revision**; see §8.)

---

## 5. Schema binding

Goal (Decision 22): generate + validate against the **current MIRA schema**, keep a running deltas list,
**don't** build hot-swap machinery.

### 5.1 Vendoring & pinning

- MIRA has **no releases/tags** → pin by **commit SHA**. Vendor the full import closure (`mira.yaml`,
  `discoursegraphs_base.yaml`, `sioc.yaml`, `dct.yaml`, `prov.yaml`, `schemaorg.yaml`) into
  `schema/vendor/`; record SHA+branch+date in `SOURCE.txt`. (Vendoring is required anyway — the imports
  are local YAML stubs.)
- **DECISION-NOTE — bind STRICTLY to `main`** (SHA `f7d0449a34efe776e4ca69a350ebaa8fa60fcc19`, verified
  2026-06-09). **No proposal-branch classes.** The overlay adds only our own *generic* extensions
  (envelope, identity, bundles, reified relations); `Criterion`/`Endorsement`/`Project`/`Grant`
  (+`endorsed`/`funder`/`scope`) were considered and **dropped** (owner, 2026-06-09 — see R9). Mission/
  CFP extracts to **Questions only**. `make schema-refresh` re-pulls a chosen SHA.

**Schema realities to design around** (verified from the YAML):
- **No enums; nothing `required`; `default_range: string`** → generated Pydantic/JSON-Schema are
  permissive; hard validation comes from our overlay.
- `mira.yaml`'s `Claim`/`Evidence` are plain `NodeSchema` mixins and **do not attach** the
  `addresses`/`supports`/`observation*`/`sourceDocument` slots at class level (the slots exist
  globally). `mira.yaml` adds `Study`/`Request`/`Protocol` + `follows`/`grounds`/`request_*`.
- `NodeSchema` slots: `created, modified, creator, description, has_container` (+ `format, content`).
  **`creator` → `UserAccount`**; **`Agent` (= `foaf:Agent`)** exists with `name`/`account`; **`Container`
  + `has_container`/`container_of`** exist — the native grouping primitive our `Bundle` extends.
- `description` is a `{format, content}` object, not a bare string.
- **Relations are reified as nodes** in MIRA's `sampleData.json` (the `RelationDef`/`AbstractRelationDef`/
  relation-instance pattern); the JSON-LD context also defines them as `@type:@id` properties. We
  reify ([§10](#10-output-mira-graph-ld-format)).

### 5.2 The `mirax:` extension overlay

`schema/mira_x.yaml` `imports: [mira]` and adds what core MIRA lacks but our decisions require. The
diff vs vendored `mira.yaml` **is** the [schema-deltas](#17-schema-deltas-running-list) list. It defines:

- **prefix** `mirax: http://purl.org/mira-science/extraction#`
- **Enums:** `EpistemicStatus`, `ActivityModality`, `CurationStatus`, `GroundingStatus`, `AgentKind`
  (`researcher`/`organization`/`funder`/`user`/`entity`), `IdScheme` (`orcid`/`ror`/`openalex`/`did`/`minted`).
- **Envelope carriers:** `SourceSpan`, `Provenance`, and a `Grounded` node mixin carrying `source_span`,
  `provenance`, `epistemic_status`, `activity_modality`, `curation_status`, `content_hash`, and
  **`creator`** (an `Agent` reference — see identity below).
- **Identity:** widen/define so **`creator` ranges over `Agent`** (the published `creator→UserAccount`
  indirection is normalized in the overlay); add **`Agent` slots** `agent_kind`, `identifier`
  (`{scheme, value}`, e.g. ORCID/ROR/DID), `external_ids`; add relation **`affiliatedWith`** (`Agent →
  Agent`, e.g. person→org).
- **Grouping:** `Bundle` (the primitive — `name`, `members[]` of `mirax:MemberRef{ref, content_hash}`,
  `creator`, `provenance`, `createdAt`) and an *optional* `Narrative` overlay (`over_bundle` reference +
  `prose`/`prose_blob`/`references[]`/`abstract`; **not** a `Bundle` subtype). Mirrors RRGI's `bundle`;
  `Bundle` maps upstream to MIRA's native `Container`/`container_of` (we use `mirax:Bundle` for the
  richer members semantics).
- **Slot-attachment fixes:** attach `addresses` to `Claim`, `supports`/`opposes` to `Argument`, etc.,
  so **closed** JSON-Schema validation accepts our output. (**No proposal-branch classes** — see §5.1.)

### 5.3 Codegen & validation

`schema/Makefile` (`make schema`):
```
gen-pydantic     schema/mira_x.yaml > schema/generated/mira_models.py
gen-json-schema  schema/mira_x.yaml --closed -t <TargetClass> > schema/generated/mira.<TargetClass>.schema.json
gen-jsonld-context schema/mira_x.yaml > schema/generated/mira.context.jsonld
```
- The **per-call extraction JSON Schema** (the extractor's I/O contract) is hand-authored and distinct
  from the MIRA validation schema; reconciled in `schema_binding/serialize.py`.
- **Validation boundary (verified 2026-06-09).** `linkml-validate` runs on the **slot-name model form**
  of each node (e.g. `linkml-validate -s schema/mira_x.yaml -C Claim node.json`). Closed validation
  **rejects JSON-LD keywords** (`@id`/`@type`/`@context` → "additional properties not allowed"), so the
  serializer (`serialize.py`) maps between the validated model form and the JSON-LD output — it adds
  `@id` (from the node's local id), `@type` (from its class), and the `@context` **after** validation.
  **Validate pre-serialization.** Verified: `Claim`, `Relation`, `Bundle`, `Agent` instances pass closed
  validation (regression fixtures in `schema/examples/`). Violations are reported per node (id+slot+
  reason); invalid nodes are flagged, not dropped (advisory).
- **Output `@context`** is an array `[<PURL>, {<mirax terms>}]` so MIRA-core consumers ignore `mirax:`
  and our UI reads it. Canonical PURL: `https://purl.archive.org/purl/mira-science/mira.jsonld`.

---

## 6. Compliance / quarantine gate

`compliance/gate.py`, per PDF, **before** extraction (Decision 19 — quarantine on uncertainty; never
drop, never force-extract). Checks short-circuit to quarantine on first hard-fail:
1. **Valid file** — opens as PDF; `< MAX_FILE_MB` (50); `< MAX_PAGES` (100); Docling
   `ConversionStatus ∈ {SUCCESS, PARTIAL_SUCCESS}`.
2. **Real text layer** — Docling `ConfidenceReport`: quarantine if `mean_grade ∈ {POOR, FAIR}` or
   `parse_score < PARSE_SCORE_MIN` (0.5); cross-checked by a PyMuPDF empty-text probe over
   `SCANNED_PAGE_FRAC` (0.6) of pages. Scanned → quarantine (or OCR if `INGEST_OCR_FALLBACK`).
3. **Expected doc type** — classifier ([§7.1](#71-doc-type-routing)); quarantine if
   `doctype_confidence < DOCTYPE_MIN` (0.6) or it contradicts the funder-assigned slot.
4. **Confidently scientific** — LLM+heuristics (references/abstract/sections; not a deck/invoice);
   below `SCIENCE_MIN` (0.5) → quarantine.

**Per-file report** (`compliance.json`, at `GET /api/documents/{id}/compliance`):
```json
{ "document_id":"...", "status":"pass|quarantine|error",
  "checks":[ {"name":"valid_file","passed":true,"score":1.0},
    {"name":"text_layer","passed":true,"score":0.82,"docling":{"mean_grade":"GOOD","parse_score":0.82}},
    {"name":"doc_type","passed":true,"detected":"proposal","confidence":0.91,"assigned":"proposal"},
    {"name":"scientific","passed":true,"score":0.88} ],
  "quarantine_reason":null, "remediation":"Re-upload a text-based PDF, or enable OCR fallback.",
  "docling_status":"SUCCESS" }
```
Quarantined docs set `jobs.state=quarantined`, do not extract, appear in `GET /api/quarantine` with a
re-queue action.

---

## 7. Doc-type routing & per-doc-type extractors

**Every doc type produces one `Bundle`** ([§4.9](#49-bundles--narratives-grouping)) of its exploded
MIRA nodes/edges, stamped with its author identity ([§4.10](#410-identity-stamping-authorship)).

### 7.1 Doc-type routing

`doctypes/classify.py`. Enum: `mission`,`cfp`,`proposal`,`author_profile`,`prior_art`,`unknown`. Fuse:
explicit funder slot (strongest) · filename/folder hints (directory uploads) · a content classifier
(one LLM call over first ~2 pages + headings → `{doctype, confidence, rationale}`, rationale stored).
Conflict/low-confidence → quarantine. `prior_art` and `author_profile` are usually *derived*, not uploaded.

### 7.2 Proposal extractor (`doctypes/proposal.py`)

Proposer-side bundle. Whitelist: `Question`,`Claim`,`Evidence`,`Study`,`Protocol`,`Request`,`Argument`
(+ relations `addresses`,`supports`,`opposes`,`grounds`,`follows`,`request_for`,`request_target`).
**Two sub-bundles within the proposal bundle**, distinguished by `activity_modality` (Decision 7):
- **Proposed-work sub-bundle** — `Study`/`Protocol` + target `Claim`s, tagged
  `activity_modality=proposed`, claims `epistemic=hypothesis` for forward-looking text. The proposal may
  also be modeled as a `Request` (`request_for` the Study, `request_target` the Claims).
- **Preliminary-results (WIP) sub-bundle** — `Evidence`/`Claim`/`Study` for done work, tagged
  `in_progress|completed`, `epistemic=claim|observation`, with `Study grounds Evidence` and `Evidence
  observationStatement Claim`.
Stamped with the proposer Agent. (Grouping = sub-bundles; classification = modality tags; orthogonal.)

### 7.3 Mission + CFP extractor (`doctypes/mission_cfp.py`)

Funder-side bundle (Decision 8, **revised** — see R9). Whitelist: `Question` (+ optional `Request`).
CFP is optional, **same slot** as mission, merged in.
- **Questions** — the scientific unknowns the funder cares about. This is the funder-side spine that
  proposal `Claim`s `address` for the connectivity model (§9).
- The CFP may optionally be modeled as a `Request`.
- **No `Criterion`** (dropped — not in `main`; §5.1). Funder eligibility/priorities, if captured at all,
  ride as prose in the mission bundle, not as discourse nodes. Stamped with the funder Agent.

### 7.4 Author profile (`doctypes/author_profile.py` + `identity/`)

**DECISION-REVISION (Decision 9).** The author profile is **not** a separate citation/bibliometric
graph. It is: **discover the researcher's authored papers → extract each into a MIRA Bundle →
stamp it with the paper's author identities (ORCIDs) and create `affiliatedWith` edges to institutions
(RORs)**. The researcher is an `Agent` identity, never a discourse node. ORCID source: explicit
submission field, or regex-extracted from the proposal (`\d{4}-\d{4}-\d{4}-\d{3}[\dX]`) + confirmed. No
ORCID → skip gracefully.

- **Discovery & identity** via OpenAlex/ORCID — see [§8](#8-identity-layer-authorship-affiliation-collaboration).
- **Which papers (bounded, v1):** the proposer-curated "top" pubs if supplied; else **DECISION-NOTE:
  the proposer's top 5 works by OpenAlex `cited_by_count`**, labeled **explicitly** as auto-selected-by-
  citation-count (`provenance.selection_basis = "auto:top5_by_cited_by_count"` vs `"proposer_curated"`;
  pane-1 label "Top 5 by citation count (auto-selected, not proposer-curated)"). Extracting **all**
  authored works is the retroactive-corpus vision (deferred, [§18](#18-deferred-explicitly-not-now)).
- **Per paper:** PDF supplied → full extraction (role `curated_pub`). DOI only → resolve via OpenAlex;
  fetch `open_access.oa_url`/`primary_location.pdf_url` for full extraction, else extract at abstract
  level from `abstract_inverted_index` with `confidence` low + `curation=in_review`. Each paper → its
  own Bundle, stamped with **all** its author Agents → the proposer's **collaboration** is derivable
  from co-stamped identities across these bundles ([§8](#8-identity-layer-authorship-affiliation-collaboration)).
- A top-level **"<researcher>'s contributions" Bundle** collects the proposer's authored bundles
  (RRGI: "I maintain a bundle of my own contributions").

### 7.5 Prior art (`doctypes/prior_art.py`)

Decision 10/19 — v1 = the proposal's **own reference list only**. Parse the bibliography (Docling section
detection + per-reference parsing → DOIs/titles); resolve each to an OpenAlex work → a `SourceDocument`
node (DOI/title/year slots; span = in-text ref + bib entry). Grouped into a **prior-art Bundle**. v1
does **not** extract claims from every reference (deep expansion deferred). Establishes the
`SourceDocument` set + citation overlap for linking ([§9](#9-linking-funder-side--proposer-side)).

---

## 8. Identity layer: authorship, affiliation, collaboration

`identity/` + `lenses/`. **(Rewritten in v0.2; supersedes the v0.1 "bibliometric sidecar".)**

> **DECISION-REVISION (Decision 9).** Old: "no human nodes in MIRA by design; ORCID→OpenAlex
> collaboration/domain graph (a sidecar)." **New:** *No human **discourse** nodes. Researchers,
> organizations, funders, and users are first-class **`Agent` identities** (ORCID / ROR / minted-DID-
> later), **stamped as the author (`creator`) of every node and bundle they produce**, and **related
> in-graph** via `affiliatedWith` (person↔org). Collaboration, affiliation,
> and standing live in the one graph (as edges and read-time lenses), not in a separate bibliometric
> graph.* This is RRGI's identity model (the human is the **identity behind** a node — its DID; we use
> ORCID), with affiliation/funding as ordinary edges between identities.

### 8.1 What lives in the graph

- **Agent nodes** (`mira:Agent`, `agent_kind ∈ {researcher, organization, funder, user, entity}`),
  identified by `identifier{scheme, value}`: ORCID for people, ROR for orgs, OpenAlex id as a secondary
  id, a minted `did:mira:<uuid>` for funders/users without an external id (DID-shaped so it becomes a
  real DID later with no model change).
- **Authorship**: `creator` on every discourse node/edge/bundle → the author Agent `@id` (the identity
  behind the content), distinct from `provenance.was_generated_by` (the system). 
- **Affiliation**: `affiliatedWith` (`Agent person → Agent org`), reified like any edge, with provenance
  `was_generated_by=importedFromSource` (OpenAlex). Funders are `Agent`s too; v1 does **not** model
  `Grant`/`Project` nodes (dropped with the proposal-branch classes, §5.1).

### 8.2 OpenAlex / ORCID as a data source (not a sidecar)

Used only to **populate identities + discover/fetch papers** (verified facts in
[Appendix A](#appendix-a--pinned-external-facts-verified-2026-06-09)):

- **ORCID public API** `https://pub.orcid.org/v3.0` (no token needed for public data; register a free
  `/read-public` client for ≈100k/day) → name, employments (→ org Agents + `affiliatedWith`), works+DOIs.
- **OpenAlex** `https://api.openalex.org` — **usage-based API key** (Feb 2026; the old `mailto` pool is
  gone). `?api_key=…`. **Single-entity lookups by ID/DOI are free**; list/`group_by` = $0.0001; search =
  $0.001. **DOI-first** resolution keeps cost ≈ $0. `select=` to drop `abstract_inverted_index` (it
  breaks case-folding JSON parsers). Resolve author by ORCID
  (`/authors/https://orcid.org/{orcid}`) → `display_name`, `summary_stats` (h-index/i10), `affiliations`
  (→ org Agents + `affiliatedWith`), `topics`. Works:
  `/works?filter=author.id:{id}&per-page=200&cursor=*`. Each work's `authorships[]` → co-author Agents
  (ORCID) + institution Agents (ROR), which is what makes collaboration derivable.

All responses cached (`http_cache` + blobs); `meta.cost_usd` logged per call ([§13](#13-reproducibility-of-a-run)).

### 8.3 Collaboration & standing as read-time lenses

`lenses/collaboration.py`, `lenses/standing.py`. **Derived, not stored** (RRGI's swappable-lens pattern):

- **Collaboration lens** — for Agent `A`: collect every Bundle `A` authored or is stamped on;
  the other Agents co-stamped on those bundles (or authoring connected nodes) are collaborators; edge
  weight = co-occurrence count. Returns a co-author graph + institutions (via `affiliatedWith`) + domains
  (via authored nodes' topics). Served at `GET /api/agents/{id}/collaboration`.
- **Standing lens** — `A`'s position in the discourse graph: authored bundles, how their claims connect/
  are endorsed, plus OpenAlex `summary_stats` (works_count, cited_by_count, h_index) as context metadata
  on the Agent. Served at `GET /api/agents/{id}/standing`. (Rich graph-position standing matures as the
  shared graph grows — see [§18](#18-deferred-explicitly-not-now).)

A different AppView could compute these differently over the same stored graph — that is the point.

### 8.4 Future: node claiming & attribution upgrade (deferred; seams left in v1)

v1 already records two **distinct** identities per node: the **producer** (`provenance.was_generated_by
= aiAssistedExtraction` + run/tool) and the **referent** (the ORCID/ROR `Agent` it is attributed to).
When the graph is later published to AT Protocol (the RRGI publishing adapter, [§18](#18-deferred-explicitly-not-now)),
each record is **signed by the extraction tool's DID** (it owns the PDS repo); the ORCID rides along as
the in-body referent. A researcher can then **claim a node without us editing it** (ATProto records are
owner-edit-only): they publish a **signed record in their own repo** referencing the node by
`strongRef {uri, cid}` — an *authorship claim* ("this is mine") or a *verification* ("this extraction
faithfully represents what I said"), modeled on RRGI's `issueClaim` / `endorsement`. The claim is
**trustworthy** when the claimant's DID `alsoKnownAs` the ORCID the node was stamped with (bidirectional
ATProto↔ORCID proof). **Effect:** nothing is rewritten (history is immutable) — a **read-time lens**
upgrades the node's effective attribution (ORCID-asserted → DID-claimed) and advances `curation_status`
`ai_extracted → expert_verified`. A claim is simply a **curation event whose actor is a verifiable DID**.

**v1 builds none of this** — it only leaves the three seams it already has: `content_hash` (→ the CID a
future claim's `strongRef` pins), the referent recorded distinctly from the producer, and the
`curation_status` lifecycle. (When we publish, split the overlay's `creator` into an explicit
`attributedTo` referent vs a `publishedBy` signing DID so the two never conflate.)

---

## 9. Linking funder-side ↔ proposer-side

`linking/linker.py` (Decisions 11, 20). Alignment is **graph connectivity, not text similarity** — but
the **alignment algorithm/metric is deferred** (Decision 39). This step builds the **connective tissue**;
it does **not** compute a score.

Joins (each emits reified link edges with provenance; candidate links default to `curation=in_review`):
1. **Questions** (the **primary** alignment signal) — propose `addresses` edges from proposal `Claim`s
   to funder-side `Question`s (transparent matcher: shared key terms + shared `Topic`/`field` + optional
   embedding **as a candidate generator only**). Never auto-asserted.
2. **Prior-art overlap** — dedup `SourceDocument`s across funder refs (if any), proposal refs, and
   curated pubs on **normalized DOI / OpenAlex id**; emit shared-work links. The concrete, defensible v1
   signal.
3. **Identity joins** — shared **Agent** identities (proposer ORCID appearing as a co-author in prior
   art; funder/institution links) connect bundles across the submission.
4. **Bundle ↔ bundle** — because relations are endpoint-agnostic, funder-side and proposer-side
   **bundles** can be related directly (e.g. proposal-bundle `addresses` mission-bundle) as a coarse view.

Output: the **linked submission graph** = funder-side ∪ proposer-side ∪ identity layer ∪ link edges,
at `GET /api/submissions/{id}/graph`. `GET …/alignment` returns the connectivity scaffold +
`"metric": null, "status": "deferred"`.

---

## 10. Output: MIRA graph-LD format

`schema_binding/serialize.py`. The internal graph (`nodes[] + edges[] + bundles[] + agents[]`, each with
an `Envelope`) → JSON-LD.

**Top-level** (matches MIRA's `sampleData.json`):
```json
{ "@context": [
    "https://purl.archive.org/purl/mira-science/mira.jsonld",
    { "mirax":"http://purl.org/mira-science/extraction#",
      "source_span":{"@id":"mirax:sourceSpan"}, "provenance":{"@id":"mirax:provenance"},
      "epistemic_status":{"@id":"mirax:epistemicStatus"}, "activity_modality":{"@id":"mirax:activityModality"},
      "curation_status":{"@id":"mirax:curationStatus"}, "members":{"@id":"mirax:members"},
      "affiliatedWith":{"@id":"mirax:affiliatedWith","@type":"@id"} } ],
  "@graph": [ ...discourse nodes, reified Relation edges, Agent nodes, Bundle nodes... ] }
```

**Discourse node** (example `Claim`):
```json
{ "@id":"node:clm-0007", "@type":"mira:Claim", "title":"Warming reduces microbiome diversity",
  "description":{"format":"text/plain","content":"..."},
  "created":"2026-06-09T12:00:00Z", "creator":"orcid:0000-0002-1825-0097",
  "epistemic_status":"hypothesis", "curation_status":"ai_extracted",
  "mirax:contentHash":"sha256:...",
  "mirax:sourceSpan":{"quote":"we hypothesize that warming reduces diversity","doc_id":"doc:proposal",
                      "char_start":10432,"char_end":10489,"page":4,"bbox":[72.0,210.4,520.1,232.7],
                      "grounding":"verified"},
  "mirax:provenance":{"run_id":"run:...","backend":"openrouter","model":"mistralai/...:free",
                      "fallback_path":["..."],"prompt_id":"proposal.extract.v3","prompt_sha":"...",
                      "schema_sha":"f7d0449...","chunk_id":"chunk:12","confidence":0.78,
                      "was_generated_by":"aiAssistedExtraction","raw_completion_sha":"...","extracted_at":"..."} }
```

**Reified edge** (relations are nodes — canonical, per MIRA's `sampleData.json`; each carries its own
envelope so relations are grounded too):
```json
{ "@id":"node:rel-0031", "@type":"mirax:Relation", "relation_type":"mira:addresses",
  "source":"node:clm-0007", "destination":"node:qst-0002",
  "creator":"orcid:0000-0002-1825-0097", "curation_status":"in_review",
  "mirax:sourceSpan":{...}, "mirax:provenance":{...} }
```
A flattened convenience view (edges as direct `@type:@id` properties) is *derivable* at
`GET /api/documents/{id}?flatten=true` — **not** canonical, lossy for per-edge grounding.

**Agent (identity) node** + **affiliation edge**:
```json
{ "@id":"orcid:0000-0002-1825-0097", "@type":"mira:Agent", "mirax:agentKind":"researcher",
  "name":"Jane Researcher", "mirax:identifier":{"scheme":"orcid","value":"0000-0002-1825-0097"},
  "mirax:externalIds":{"openalex":"A5048491430"},
  "mirax:metadata":{"works_count":84,"h_index":31,"cited_by_count":4210} }
{ "@id":"ror:01an7q238", "@type":"mira:Agent", "mirax:agentKind":"organization", "name":"UC Berkeley",
  "mirax:identifier":{"scheme":"ror","value":"01an7q238"} }
{ "@id":"node:rel-aff-1", "@type":"mirax:Relation", "relation_type":"mirax:affiliatedWith",
  "source":"orcid:0000-0002-1825-0097", "destination":"ror:01an7q238",
  "mirax:provenance":{"was_generated_by":"importedFromSource","source":"openalex"} }
```

**Bundle** (one per document; the grouping primitive — nodes stay grouped):
```json
{ "@id":"bundle:proposal", "@type":"mirax:Bundle", "name":"Proposal: Climate microbiome",
  "creator":"orcid:0000-0002-1825-0097",
  "members":[ {"ref":"bundle:proposal-proposed","content_hash":"sha256:..."},
              {"ref":"bundle:proposal-wip","content_hash":"sha256:..."},
              {"ref":"node:clm-0007","content_hash":"sha256:..."},
              {"ref":"node:rel-0031","content_hash":"sha256:..."} ] }
```
An *optional* `Narrative` overlay may reference this bundle when prose is retained (not on the v1 path):
`{"@id":"narr:proposal","@type":"mirax:Narrative","over_bundle":["bundle:proposal"],"mirax:prose_blob":"sha256:..."}`.
`@id`s are CURIEs in per-document `node:`/`bundle:`/`doc:` namespaces; identities use stable
`orcid:`/`ror:`/`did:mira:` ids; `SourceDocument` uses a DOI-derived id — so the linked graph merges
cleanly.

---

## 11. HTTP API (API-first)

`api/`. **API-first (Decision 20):** the UI, PRSM, the future alignment algorithm, and other consumers
read these endpoints (RRGI AppView pattern). FastAPI; JSON; OpenAPI at `/docs`.

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /api/submissions` | Create a submission | `{title, funder_agent_id?, proposer_orcid?, curated_pub_dois?}` → `{submission_id}` |
| `POST /api/submissions/{id}/files` | Upload PDFs (multipart) or a `.zip` | each file `{role?}`; enqueues a job per file |
| `GET /api/submissions` / `GET /api/submissions/{id}` | List / detail (+ documents + job status) | |
| `GET /api/submissions/{id}/queue` | Job status | `[{document_id, kind, state, attempts, error}]` |
| `GET /api/documents/{id}` | The document's graph-LD (canonical = reified relations) | `?flatten=true` for the lossy convenience view |
| `GET /api/documents/{id}/compliance` | Per-file compliance report | §6 |
| `GET /api/documents/{id}/source` | Docling text stream + offset records | for source-span highlighting |
| `GET /api/submissions/{id}/graph` | Merged + **linked** graph-LD (discourse ∪ identity ∪ links) | |
| `GET /api/agents/{id}` | One Agent identity + its edges | |
| `GET /api/agents/{id}/collaboration` | **Derived** collaboration lens (co-authors, institutions, domains) | §8.3 |
| `GET /api/agents/{id}/standing` | **Derived** standing lens (+ OpenAlex context metadata) | §8.3 |
| `GET /api/bundles/{id}` | A bundle's members (+ per-member content-hash seal) | |
| `GET /api/bundles?member={node_id}` | Reverse: which bundles contain a node | from `bundle_members` |
| `GET /api/submissions/{id}/alignment` | Alignment scaffold | `{"metric":null,"status":"deferred"}` |
| `GET /api/nodes/{id}` | One node/edge + full envelope + neighbors | |
| `PATCH /api/nodes/{id}` | Curation: set `curation_status`, edit, merge/split | appends `curation_events` |
| `GET /api/runs/{id}` | Reproducibility manifest | §13 |
| `GET /api/quarantine` | Quarantined documents + reasons | |
| `POST /api/documents/{id}/requeue` | Re-enqueue | |
| `GET /api/healthz` | Liveness + backend/model availability | |

- **Async:** uploads return ids immediately; clients poll `…/queue`. Graph endpoints `404`/`409` while
  `queued`/`running`/`quarantined`.
- **Payloads:** graph endpoints return the [§10](#10-output-mira-graph-ld-format) shape; validation
  violations appear as an advisory `"_validation"` block, never by withholding the graph.
- **Auth:** v1 = none / single-tenant local; a `tenant_id` column is reserved.

---

## 12. 4-pane UI (an API client)

`web/`. Next.js App Router; consumes only the API. Four panes (workshop sketch / BUILD-PLAN component 7):

1. **Collaboration standing** — the researcher's authored **bundles** (their papers as MIRA graphs) +
   the **collaboration lens** (`GET /api/agents/{id}/collaboration`: co-author graph in Cytoscape,
   institutions via `affiliatedWith`, domains) + standing context (`works_count`, `h_index`). Fully-
   extracted "top pubs" show their **selection basis** ("proposer-curated" or "Top 5 by citation count
   (auto-selected, not proposer-curated)"). Empty-state when no ORCID.
2. **What the proposal proposes** — the proposal MIRA graph with a **proposed ↔ preliminary (WIP)** toggle
   (sub-bundles + `activity_modality`). Node click → source-span highlight + envelope + author identity.
3. **Ecosystem relation** — prior-art `SourceDocument`s + topic context + prior-art overlap with the
   funder side, with an **adjustable-granularity** control (collapse to topic/field; bundle vs granular).
4. **Mission alignment** — **placeholder** (Decision 39): renders the linking scaffold (which Claims
   `address` which Questions, prior-art overlap) **without a score**; banner says the metric is not yet
   implemented.
- **"How this works" tab** (white-box) — pipeline steps, the run manifest (models, prompts+versions,
  schema SHA), per-node provenance + author identity + confidence + grounding status, and **curation
  controls** (verify/reject/edit) that PATCH nodes — the human-in-the-loop surface.

---

## 13. Reproducibility of a run

`engine/provenance.py` + `runs`. Each execution writes a manifest (`manifest.json` blob):
```json
{ "run_id":"run:...", "submission_id":"...", "document_id":"...", "created_at":"...",
  "inputs":{"pdf_sha256":"...","filename":"...","role":"proposal"},
  "schema":{"repo":"MIRA-science/schema","branch":"main","sha":"f7d0449...","overlay_sha":"<mira_x.yaml sha>"},
  "ingest":{"docling_version":"2.99.0","do_ocr":false,"docling_status":"SUCCESS",
            "confidence":{"mean_grade":"GOOD","parse_score":0.82}},
  "chunking":{"max_tokens":1200,"overlap":150,"n_chunks":14,"chunker_version":"1"},
  "extraction":{"strategy":"joint","prompt_id":"proposal.extract.v3","prompt_sha":"...",
                "backend_chain":[{"backend":"openrouter","model":"...:free"}],
                "per_chunk":[{"chunk_id":"...","model_used":"...","fallback_path":[],"raw_completion_sha":"..."}]},
  "identity":{"orcid":"0000-...","openalex_queries":[{"url":"...","cost_usd":0.0001,"response_sha":"..."}],
              "agents_created":12,"affiliations":4,"total_cost_usd":0.0034},
  "bundles":{"bundles":3,"members_total":140},
  "validation":{"validator":"linkml-validate","root_class":"...","violations":0},
  "libraries":{"python":"3.12.x","docling":"2.99.0","linkml":"x.y.z","pydantic":"2.x"},
  "outputs":{"graph_sha":"...","n_nodes":131,"n_edges":88,"n_agents":12} }
```
- Deterministic parts (inputs + config + schema SHA + prompt SHAs) replay exactly. **LLM
  nondeterminism** is bounded by the **completion cache**: a re-run with the same manifest replays the
  exact `raw_completion_sha`s → bit-identical graph; a fresh run reproduces the *process*, not
  necessarily token-identical output (Opus 4.8 has no temperature). Stated plainly in "How this works."
- OpenAlex/ORCID responses are cached by URL (drift-proof replay); cost logged per call.

---

## 14. Testing & evaluation

Lightweight (Decision 23); gold set deferred → lean on **intrinsic, gold-free metrics** + tiny fixtures
+ human spot-check via curation.

- **Intrinsic metrics** per run: `schema_validity_rate`; `grounding_rate` (verified/fuzzy/unverified —
  primary quality proxy); `dedup_ratio`; `coverage` (nodes/1k tokens per type); `bundle_integrity`
  (every member resolves; content_hash matches); `identity_resolution_rate` (authorships → Agents);
  `backend_health` (fallback freq, retries); `cost` (OpenAlex `cost_usd` + LLM tokens).
- **A/B runners** (decide the empirical choices — Decisions 13/14; granularity): `staged` vs `joint`;
  chunk size/overlap sweeps; backend/model comparison. Each writes `eval/reports/<ts>.json`.
- **Fixtures** (`eval/fixtures/`): a few small license-clean PDFs (1 proposal, 1 mission, 1 short paper).
  Tests assert *shape* (mission → ≥1 Question; proposal → both proposed + WIP sub-bundles;
  references → ≥1 SourceDocument; author paper → ≥1 Agent + ≥1 affiliatedWith) and validity, **not**
  exact content.
- **Unit tests** (pytest): chunker offsets round-trip to exact substrings; grounding verifier; dedup/
  merge; backend fallback ladder (mocked `SchemaUnsupported`/`429`/`402`); compliance decisions;
  serializer (reified output validates; `?flatten` round-trips); bundle assembly + reverse index; DOI
  normalization; ORCID/OpenAlex clients vs recorded fixtures (no live calls in CI); collaboration lens.
- **UI smoke** (Playwright): upload → queue → 4 panes render → node click highlights source span.
- **Later (deferred gold set):** node/edge precision/recall/F1; the single-agent baseline becomes the
  distillation teacher (Decision 15). Hooks left in `metrics.py`.

---

## 15. Configuration & secrets

`config.py` (pydantic-settings) + `.env`; `.env.example` documents every key.
```
# LLM
OPENROUTER_API_KEY=...
OPENROUTER_APP_URL=https://...        # HTTP-Referer
OPENROUTER_APP_TITLE=MIRA Extraction  # X-Title
MISTRAL_API_KEY=...                   # optional
ANTHROPIC_API_KEY=...                 # optional (paid escalation)
LLM_ALLOW_PAID=false
EXTRACTION_STRATEGY=joint             # joint|staged
LLM_FALLBACK_MODELS=                  # optional override; else discovered at runtime

# Identity / bibliographic data source
OPENALEX_API_KEY=...                  # required (usage-based since Feb 2026)
ORCID_CLIENT_ID=...  ORCID_CLIENT_SECRET=...   # optional (higher quota; public works w/o)
MINTED_ID_PREFIX=did:mira             # DID-shaped placeholder namespace for funders/users/entities

# Ingest / chunking
INGEST_OCR_FALLBACK=false
CHUNK_MAX_TOKENS=1200
CHUNK_OVERLAP_TOKENS=150

# Compliance thresholds
PARSE_SCORE_MIN=0.5  DOCTYPE_MIN=0.6  SCIENCE_MIN=0.5  SCANNED_PAGE_FRAC=0.6
MAX_FILE_MB=50  MAX_PAGES=100

# Schema
MIRA_SCHEMA_BRANCH=main
MIRA_SCHEMA_SHA=f7d0449a34efe776e4ca69a350ebaa8fa60fcc19

# Author-profile extraction scope
TOP_PUBS_DEFAULT_N=5                   # top-N by cited_by_count when no curated list

# Storage
DATA_DIR=./data
```
Secrets never logged. `GET /api/healthz` reports configured backends + discovered free models without
leaking keys.

---

## 16. Phases & milestones

Dependency-ordered, thin-slice-first (mirrors BUILD-PLAN; each phase ends demoable).

**Phase 0 — Skeleton.** Repo scaffold; vendor+pin schema; `make schema`; the `Extractor`/`LLMBackend`
interfaces; Docling ingest + offset stream; single-agent joint extraction of one doc type (proposal);
validate; dump `graph.jsonld`. _Done: one real proposal PDF → valid MIRA graph-LD end to end (CLI)._

**Phase 1 — Core engine.** Offset-preserving chunker; grounding + provenance + 3 status axes +
**author-identity stamping** on every node/edge; **bundle assembly**; backend fallback chain +
cache; dedup/merge; validation + `mira_x.yaml` overlay (envelope + Bundle + Agent + affiliatedWith) +
deltas log; eval harness with intrinsic metrics. _Done: the engine is the stable,
measured, swappable core; one document → one validated, bundled, identity-stamped graph._

**Phase 2 — Front door.** Upload (single + directory/zip); doc-type classify+route; compliance/quarantine
+ per-file report; SQLite + blob store; FIFO worker (concurrency 1); job-status API. _Done: a user can
upload and watch documents process/quarantine._

**Phase 3 — Doc-type extractors + identity layer.** Proposal (proposed + WIP sub-bundles), mission/CFP
(Questions + funder Agent), author profile (ORCID→OpenAlex identity resolution;
Agent nodes + `affiliatedWith`; top-N authored papers → bundles), prior art (reference list → prior-art
bundle). Collaboration + standing lenses. _Done: each input type yields its bundle; identities + edges
populate; lenses compute._

**Phase 4 — Linking.** Funder ↔ proposer join on Questions/DOIs/**identities**/bundle↔bundle;
linked submission graph; alignment scaffold (metric = deferred). _Done: shared Questions/DOIs/identities
connect the graphs._

**Phase 4b — API surface.** All [§11](#11-http-api-api-first) endpoints incl. agents/collaboration/
standing/bundles; canonical reified graph-LD (+ optional `?flatten`); curation PATCH + events; run
manifest. _Done: any result is pullable + curatable programmatically._

**Phase 5 — 4-pane UI.** Panes 1–3 against the API (pane 1 = bundles + collaboration lens); pane 4
placeholder; "How this works" tab with provenance + author identity + curation controls; source-span
highlighting. _Done: a funder sees the results page._

---

## 17. Schema-deltas (running list)

Maintained as the diff of `schema/mira_x.yaml` vs vendored `mira.yaml` — *is* the upstream proposal
(Decision 45). Summary:

- **Verbatim source span** on every node/edge (`mirax:SourceSpan`). MIRA has no grounding field.
- **Provenance** on every node/edge (`mirax:Provenance`, incl. `was_generated_by` vs `creator`). MIRA's
  `prov` import is an empty stub.
- **Three status axes** as enums (`EpistemicStatus`, `ActivityModality`, `CurationStatus`). None exist.
- **Identity as first-class authorship:** widen `creator` to range over `Agent`; add `Agent` slots
  (`agent_kind`, `identifier{scheme,value}`, `external_ids`); add **`affiliatedWith`** (`Agent→Agent`).
  (MIRA `main` has `Agent`/`UserAccount`/`creator` but with a `creator→UserAccount` indirection and no
  person↔org affiliation relation.)
- **Bundle** grouping (`mirax:Bundle`, the primitive) with member refs (`{ref, content_hash}` — the
  prototype of RRGI's dual-addressed `strongRef {uri, cid}`). MIRA has only a bare `Container`/
  `has_container`; we propose the richer members semantics (`Container` mapping is the merge path). An
  *optional* `mirax:Narrative` overlay references a bundle (`over_bundle`) — **not** a `Bundle` subtype.
- **Slot-attachment fixes:** `mira.yaml` defines relation slots globally but doesn't attach them to
  `Claim`/`Evidence`/`Argument`, so **closed** validation rejects conformant data; the overlay attaches.
- **(Considered, then dropped):** the proposal-branch funder-side classes (`Criterion`, `Endorsement`,
  `Project`, `Grant` + `endorsed`/`funder`/`scope`) are **not** in our overlay — v1 binds strictly to
  `main` (R9). If funder "criteria" are ever needed, `Criterion` is the single load-bearing one to add
  back as a flagged delta.
- **No enums / nothing required / `default_range:string`** upstream — we propose constrained value sets.
- **Context gaps:** the published PURL context drives `sdata:`/`some:` instance prefixes absent from the
  repo `mira.jsonld`, and references `dgb:RelationInstance`/`dgb:RelationSchema` absent from the checked-
  in `discoursegraphs_base.yaml`. Our output declares its own instance prefixes.

---

## 18. Deferred (explicitly not now)

From `DECISIONS.md`/`BUILD-PLAN.md` + this spec:
- The **alignment algorithm** + the **mission-alignment metric** (alignment/impact/potential/trust/
  value/risk/excellence). Pane 4 is a scaffold only.
- **Fine-tuned small / volunteer model** (+ **multi-agent reconciliation** as its quality tier /
  distillation teacher). Single-agent baseline + eval now (Decision 15).
- **Deep prior-art expansion** (OpenAlex-based; PRSM depth model as reference). v1 = the proposal's own
  reference list only.
- **Funder `Criterion` / `Grant`/`Project` modeling** — dropped from v1 (proposal-branch classes, §5.1).
  Revisit if funder criteria must become first-class nodes, or when `proposals` merges into `main`.
- **Extracting ALL authored works** (vs. top-N) and **retroactive corpus extraction** — the proactive
  proposal path ships first (Decision 4).
- **Rich graph-position standing / cross-submission collaboration** at scale — the lenses exist; they get
  rich once a large shared graph accumulates.
- **AT-Proto / IPFS / DID layer** (real `strongRef {uri, cid}`, signed records). v1 uses `@id` +
  `content_hash` shaped to upgrade to `at://`+CID and minted ids shaped to upgrade to real DIDs.
- **RRGI publishing** of extracted graphs (the ATProto publishing adapter: serialize → RRGI lexicon
  records, sign as the extractor DID, push to a PDS, seal to IPFS).
- **Node claiming / attribution upgrade** — a researcher claiming/verifying an extracted node via a
  signed record in their own repo (RRGI `issueClaim`/`endorsement` pattern) with DID↔ORCID
  `alsoKnownAs` proof, upgrading attribution + curation status at read time. Seams left in v1
  ([§8.4](#84-future-node-claiming--attribution-upgrade-deferred-seams-left-in-v1)); flow built with the publishing adapter.
- **Gold/eval set**; no SciOS-portfolio dogfooding.
- **PR to MIRA** — prototype + collect deltas first, PR with evidence later.
- **(This spec) Auth/multi-tenancy, SSE/websocket job streaming, schema hot-swap, image-figure
  extraction, full citation-network BFS** — reserved hooks, not built.

---

## 19. Open questions for the owner

### Resolved (owner, 2026-06-09)

- **R1. Edge serialization** → relations are **reified as nodes** (MIRA decides it; not configurable).
  Flattened view is an optional lossy `?flatten=true` helper ([§10](#10-output-mira-graph-ld-format)).
- **R2. Schema branch** → bind to **`main`** (SHA `f7d0449…`); **no** proposal-branch classes (see R9)
  ([§5.1](#51-vendoring--pinning)/[§5.2](#52-the-mirax-extension-overlay)).
- **R3. Linking** → emit candidate links `in_review`, never auto-asserted ([§9](#9-linking-funder-side--proposer-side)).
- **R4. "Top pubs" default** → **top 5 by `cited_by_count`**, explicitly labeled
  ([§7.4](#74-author-profile-doctypesauthor_profilepy--identity)).
- **R5. Identity model (revises Decision 9)** → **no human *discourse* nodes; humans/orgs/funders are
  first-class `Agent` identities** (ORCID/ROR/minted-DID), stamped as authors, related via
  `affiliatedWith`; **collaboration/affiliation/standing live in the one graph** as edges +
  read-time lenses; **no bibliometric sidecar** — OpenAlex/ORCID are a data source ([§8](#8-identity-layer-authorship-affiliation-collaboration)).
- **R6. Bundles** → every document explodes into nodes grouped in a **`Bundle`** (the primitive),
  uniformly across doc types ([§4.9](#49-bundles--narratives-grouping)). A **`Narrative`** is an
  *optional* prose overlay that **references** a bundle (`over_bundle`) — **not** a `Bundle` subtype,
  not on the v1 critical path.
- **R7. Extraction scope** → **top-N bounded** for v1; all-authored-works is deferred.
- **R8. Affiliation** → **in-graph** edge `affiliatedWith` (`Agent person → Agent org`, org id = ROR),
  sourced from OpenAlex — not external metadata.
- **R9. Drop `Criterion` + proposal-branch classes (revises Decision 8)** → bind **strictly to `main`**;
  `Criterion`/`Endorsement`/`Project`/`Grant` (+`endorsed`/`funder`/`scope`) removed from the overlay.
  Mission/CFP → **Questions only**; funder criteria, if ever needed, ride as prose or return later as a
  single flagged delta ([§5.1](#51-vendoring--pinning)/§7.3).

### Still open (safe defaults in place; flag if you disagree)

- **O1. OCR policy** — default **quarantine scanned PDFs** (OCR opt-in via `INGEST_OCR_FALLBACK`). Prefer
  OCR-on-by-default?
- **O2. OpenAlex usage-based key** — confirm we provision an **OpenAlex API key** (free tier ≈ $1/day;
  single-entity lookups free; DOI-first keeps cost ≈ $0). New external account to create.
- **O3. Minted-id scheme for funders/users** — default `did:mira:<uuid>` (DID-shaped placeholder, upgrade
  path to real `did:plc` later). OK, or prefer a different placeholder until DIDs land?

---

## Appendix A — Pinned external facts (verified 2026-06-09)

Volatile items must be re-checked at build time / discovered at runtime.

**MIRA schema** (`github.com/MIRA-science/schema`) — no releases/tags → **pin by SHA**. **We bind
STRICTLY to `main`** = `f7d0449a34efe776e4ca69a350ebaa8fa60fcc19` (no proposal-branch classes — R9).
`proposals` = `083dae81c7dd810258954cf5946563222d5069a9` adds `Criterion`/`Endorsement`/`Project`/`Grant`
— **not used**. Core classes on `main`:
`Argument, Question, Claim, Evidence, Study, Request, Protocol, SourceDocument`; `proposals` adds
`Criterion, Endorsement, Project, Grant`. Relations: `addresses/addressedBy, supports/supportedBy,
opposes/opposedBy, grounds/is_grounded_in, follows, request_for, request_target, observationStatement,
observationOriginActivity, observationBase, sourceDocument, describesActivity`; `proposals` adds
`endorsed, funder, scope`. Identity vocab present: `Agent` (=`foaf:Agent`), `UserAccount`, `creator`
(→`UserAccount`), `account`; grouping primitive present: `Container` + `has_container`/`container_of`.
**No enums; nothing `required`; `default_range:string`.** `description` is `{format, content}`.
**Relations reified as nodes** in `sampleData.json`. Imports vendored stubs (`prov`/`schemaorg` near-
empty; base slots from `sioc.yaml`+`dct.yaml`). Canonical context PURL:
`https://purl.archive.org/purl/mira-science/mira.jsonld`. LinkML CLIs: `gen-pydantic`, `gen-json-schema`
(`--closed -t <Class>`), `gen-jsonld-context`, `linkml-validate -s … -C <Class>` (JSON-Schema plugin,
closed by default). Upstream LinkML on Python 3.12 is fine to consume/validate (MIRA's repo fork + 3.14
are only to regenerate its own artifacts).

**Docling** — pin `docling==2.99.x` + `docling-core` + `docling-parse`. `DocumentConverter().convert()`
→ `ConversionResult{status: ConversionStatus, confidence: ConfidenceReport{mean_grade, parse_score,…},
document}`. Per-item `ProvenanceItem{page_no, bbox, charspan}`; **`charspan` is per-item, NOT a global
offset** → build the text stream + offsets yourself via `iterate_items()`. `BoundingBox.coord_origin`
may be `BOTTOMLEFT` → normalize with `to_top_left_origin(page_height)`. OCR via
`PdfPipelineOptions(do_ocr, ocr_options.force_full_page_ocr)`. Prefetch models into the worker image.

**OpenRouter / Mistral / Anthropic** — OpenRouter `…/api/v1/chat/completions` (OpenAI-compatible);
discover **free** models at runtime via `GET /api/v1/models` (`pricing.prompt=="0" &&
pricing.completion=="0"`) ∩ `supported_parameters`. **Don't hardcode `:free` slugs** (Mistral's
rotates). Structured output: `response_format:{type:"json_schema",json_schema:{strict:true,…}}` +
`provider:{require_parameters:true}`; fallback ladder → `json_object` + prompt schema + `json_repair`.
Free limits ≈ 20 req/min; 50/day (or 1000/day after one-time $10). Anthropic `/v1/messages`
(`x-api-key`, `anthropic-version: 2023-06-01`); models `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-haiku-4-5`; structured output `output_config.format`; **Opus 4.8/4.7 reject
`temperature`/`top_p`/`top_k`** (use `thinking:{type:"adaptive"}` + `output_config.effort`); content is a
block array. Mistral native `…/v1` (OpenAI-compatible; `json_schema`; prefer `-latest` aliases).

**OpenAlex / ORCID** — **OpenAlex is usage-based with API keys (Feb 2026)**; `?api_key=`. Free key ≈
$1/day; **single-entity (ID/DOI) lookups free**, list/`group_by` = $0.0001, search = $0.001 (log
`meta.cost_usd`). **`mailto` pool gone**; **`cited_by_api_url` removed** → use `filter=cites:{id}`.
Author by ORCID: `/authors/https://orcid.org/{orcid}`; works
`/works?filter=author.id:{id}&cursor=*&per-page=200`; `authorships[].author{orcid}` +
`authorships[].institutions{ror}` give co-authors + institutions; `affiliations[]` + `summary_stats`
(h_index/i10) on the author. **`select=` to drop `abstract_inverted_index`** (breaks case-folding JSON
parsers). **Org ids = ROR**; **person ids = ORCID**; DOI canonical lowercase `https://doi.org/10.x`.
ORCID public API `https://pub.orcid.org/v3.0` — no token for public data (anonymous ≈25k/day/IP; free
`/read-public` client ≈100k/day).

## Appendix B — Example end-to-end payloads

**Submission creation**
```http
POST /api/submissions
{ "title":"Climate microbiome RFP — Lab X proposal", "funder_agent_id":null,
  "proposer_orcid":"0000-0002-1825-0097", "curated_pub_dois":["10.7717/peerj.4375"] }
→ 200 { "submission_id":"sub:abcd" }
```

**File upload (directory)**
```http
POST /api/submissions/sub:abcd/files   (multipart)
  mission.pdf   role=mission
  proposal.pdf  role=proposal
  refs/*.pdf    role=prior_art
→ 200 { "documents":[ {"id":"doc:m1","role":"mission"}, {"id":"doc:p1","role":"proposal"}, ... ] }
```

**Collaboration lens (derived)**
```http
GET /api/agents/orcid:0000-0002-1825-0097/collaboration
→ { "agent":"orcid:0000-0002-1825-0097",
    "coauthors":[ {"agent":"orcid:0000-0001-...","name":"A. Lee","weight":7},
                  {"agent":"orcid:0000-0003-...","name":"R. Patel","weight":3} ],
    "institutions":[ {"agent":"ror:01an7q238","name":"UC Berkeley"} ],
    "domains":[ {"topic":"Microbial Ecology","field":"Ecology","weight":12} ],
    "derived_from_bundles":["bundle:pub-1","bundle:pub-2","bundle:pub-3"],
    "note":"Derived read-time lens over identity-stamped bundles; not stored." }
```

**Linked submission graph (excerpt)** — proposal Claim → mission Question candidate link + the identity layer:
```json
{ "@context":["https://purl.archive.org/purl/mira-science/mira.jsonld",{"mirax":"http://purl.org/mira-science/extraction#"}],
  "@graph":[
    {"@id":"orcid:0000-0002-1825-0097","@type":"mira:Agent","mirax:agentKind":"researcher","name":"Jane Researcher"},
    {"@id":"ror:01an7q238","@type":"mira:Agent","mirax:agentKind":"organization","name":"UC Berkeley"},
    {"@id":"node:rel-aff-1","@type":"mirax:Relation","relation_type":"mirax:affiliatedWith","source":"orcid:0000-0002-1825-0097","destination":"ror:01an7q238"},
    {"@id":"node:qst-m-0002","@type":"mira:Question","title":"How does warming affect microbiome diversity?",
     "creator":"did:mira:funder-xyz","curation_status":"ai_extracted"},
    {"@id":"node:clm-p-0007","@type":"mira:Claim","title":"Warming reduces diversity","epistemic_status":"hypothesis",
     "creator":"orcid:0000-0002-1825-0097","curation_status":"ai_extracted"},
    {"@id":"node:rel-link-0001","@type":"mirax:Relation","relation_type":"mira:addresses","source":"node:clm-p-0007","destination":"node:qst-m-0002",
     "curation_status":"in_review","mirax:provenance":{"prompt_id":"link.questions.v1","confidence":0.66}},
    {"@id":"bundle:proposal","@type":"mirax:Bundle","name":"Proposal: Climate microbiome",
     "creator":"orcid:0000-0002-1825-0097","members":[{"ref":"node:clm-p-0007","content_hash":"sha256:..."}]} ],
  "_validation":{"validator":"linkml-validate","violations":0} }
```

**Alignment (deferred metric)**
```json
GET /api/submissions/sub:abcd/alignment
→ { "connectivity":{"claims_addressing_questions":5,"prior_art_overlap_dois":["10..."]},
    "metric":null, "status":"deferred", "note":"Alignment metric not yet implemented; see SPEC §18." }
```

---

_End of SPEC v0.3. The model is locked on a single identity-stamped graph (Agents + discourse nodes,
MIRA `main` only), **Bundles** per document (Narrative = optional overlay), and collaboration/standing as
read-time lenses. Open items: O1–O3 in §19._
