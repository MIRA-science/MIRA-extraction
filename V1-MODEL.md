# MIRA-extraction — v1 Visual Model

_Companion to `SPEC.md` v0.3 · 2026-06-09 · for review._

Renders on GitHub, in VS Code (Mermaid preview), or at <https://mermaid.live>. Each diagram has a
one-line caption and a pointer to the SPEC section it depicts.

**Legend (node kinds in the graph diagrams):**
🟦 Agent / identity · ⬜ discourse node · 🟨 Bundle (Narrative = optional overlay) · 🟩 reified Relation (edge-as-node).

---

## 1. Pipeline flow (SPEC §1)

What happens to one uploaded PDF, end to end. One document at a time (FIFO); uncertainty → quarantine.

```mermaid
flowchart TD
  U["Upload: 1 PDF or a directory / zip"] --> Q["FIFO queue (one document at a time)"]
  Q --> C{"Compliance gate<br/>valid file? real text layer?<br/>expected doc type? scientific?"}
  C -->|"fail / uncertain"| QA["QUARANTINE<br/>(+ per-file report; re-queue available)"]
  C -->|pass| R{"Route by doc type"}
  R --> P["Proposal extractor"]
  R --> M["Mission / CFP extractor"]
  R --> A["Author-profile (top-N pubs)"]
  R --> PA["Prior-art (reference list)"]
  P --> E
  M --> E
  A --> E
  PA --> E
  E["CORE ENGINE<br/>chunk → LLM → MIRA nodes + reified edges<br/>grounded · provenanced · status-tagged · author-stamped"] --> B["Bundle assembly<br/>(one per document)"]
  B --> ID["Identity resolution — OpenAlex / ORCID<br/>Agent nodes + affiliatedWith"]
  ID --> V{"Validate vs MIRA + mirax overlay"}
  V -->|violations| VR["flag as advisory, keep node"]
  V -->|ok| L
  VR --> L
  L["LINK funder ↔ proposer<br/>Questions · DOIs · identities · bundle↔bundle<br/>(candidate links = in_review)"] --> S["STORE: one identity-stamped MIRA graph-LD<br/>SQLite + content-addressed blobs"]
  S --> API["HTTP API — graph-LD (RRGI AppView pattern)"]
  API --> UI["4-pane UI + 'How this works'"]
  API --> LENS["read-time LENSES<br/>collaboration · standing · alignment (scaffold only)"]
```

---

## 2. Each document → a Bundle (SPEC §4.9, §7)

Every doc type explodes into MIRA nodes that **stay grouped** in a **Bundle**. Bundles nest; the
proposal carries proposed-work and WIP as sub-bundles. (A Narrative is an optional prose overlay.)

```mermaid
flowchart LR
  subgraph FUNDER["FUNDER-SIDE"]
    MIS["Mission + CFP PDF"] --> MN["🟨 Bundle: funder-side<br/>(creator = Funder Agent)"]
    MN --> MQ["⬜ Question (funder-side spine)"]
  end
  subgraph PROPOSER["PROPOSER-SIDE"]
    PROP["Proposal PDF"] --> PN["🟨 Bundle: proposal<br/>(creator = proposer ORCID)"]
    PN --> SB1["🟨 sub-bundle: PROPOSED work<br/>Study/Protocol + Claims · modality=proposed"]
    PN --> SB2["🟨 sub-bundle: PRELIMINARY / WIP<br/>Evidence/Claim · modality=in_progress/completed"]
    PUBS["Top-N authored papers"] --> PUBN["🟨 Bundle per paper<br/>(stamped with all author ORCIDs)"]
    REFS["Proposal reference list"] --> PAB["🟨 Bundle: prior art<br/>SourceDocument nodes (DOI-keyed)"]
    CONTRIB["🟨 'this researcher's contributions' bundle"] --> PUBN
  end
```

---

## 3. The one identity-stamped graph (SPEC §4.10, §8, §10) — example instance

Humans/orgs/funders are 🟦 **Agent identities** (never discourse nodes); they **author** ⬜ discourse
nodes (`creator`) and **relate to each other** (`affiliatedWith`). Edges shown as labels are
each a 🟩 reified `Relation` node carrying its own envelope.

```mermaid
flowchart TD
  classDef agent fill:#e8f0fe,stroke:#3367d6,color:#111;
  classDef disc  fill:#ffffff,stroke:#555,color:#111;
  classDef bun   fill:#fef7e0,stroke:#b06000,color:#111;
  classDef note  fill:#f3f3f3,stroke:#999,color:#333;

  JANE["🟦 Agent · researcher<br/>orcid:0000-0002-1825-0097"]:::agent
  ORG["🟦 Agent · organization<br/>ror:01an7q238"]:::agent
  FUND["🟦 Agent · funder<br/>did:mira:funder-xyz"]:::agent

  JANE -->|affiliatedWith| ORG

  subgraph PB["🟨 Bundle: proposal — creator = Jane"]
    CLM["⬜ Claim<br/>epistemic = hypothesis"]:::disc
    STU["⬜ Study<br/>modality = proposed"]:::disc
    EV["⬜ Evidence<br/>modality = completed (WIP)"]:::disc
  end
  subgraph MB["🟨 Bundle: mission — creator = Funder"]
    QST["⬜ Question"]:::disc
  end

  CLM -->|"addresses · in_review (candidate link)"| QST
  EV -->|supports| CLM
  STU -->|grounds| EV
  JANE -. creator .-> CLM
  FUND -. creator .-> QST

  ENV["🟩 EVERY node & edge carries an ENVELOPE:<br/>source_span (verbatim quote + char offsets + page/bbox + grounding) ·<br/>provenance (backend/model/prompt/run/confidence/was_generated_by) ·<br/>status: epistemic | activity_modality | curation ·<br/>content_hash (→ future CID) · creator (author identity)"]:::note
```

---

## 4. Schema layering (SPEC §5)

We **validate against** the pinned MIRA core; everything we add lives in one **overlay** whose diff is
the upstream proposal. Verified: `gen-pydantic` + closed JSON-Schema generate for all classes.

```mermaid
flowchart TB
  subgraph OVL["mirax overlay — mira_x.yaml (OUR additions = the schema-deltas / upstream proposal)"]
    direction LR
    GR["Grounded mixin<br/>(+ creator → Agent)"]
    ENV2["SourceSpan + Provenance"]
    ST3["status enums:<br/>epistemic · activity_modality · curation"]
    BN["Bundle (primitive) + optional Narrative overlay<br/>members {ref, content_hash}"]
    REL["Relation (reified edge)"]
    IDT["Agent identity:<br/>agent_kind + identifier{scheme,value}"]
    AFF["affiliatedWith (Agent→Agent)"]
    STRICT["binds strictly to MIRA main<br/>(no proposal-branch classes)"]
  end
  subgraph CORE["MIRA core — vendored @ main f7d0449 (the output contract)"]
    direction LR
    DISC["Question · Claim · Evidence · Study ·<br/>Protocol · Request · Argument · SourceDocument"]
    BASE["NodeSchema (created/creator/…) ·<br/>Agent / UserAccount · Container"]
  end
  OVL -->|"imports + augments (attaches relation slots, adds envelope)"| CORE
```

---

## 5. API → 4-pane UI (SPEC §11, §12)

API-first: the UI is one client; lenses are computed read-time. Pane 4 is a placeholder (metric deferred).

```mermaid
flowchart LR
  subgraph EP["HTTP API (graph-LD)"]
    e1["/submissions/{id}/graph"]
    e2["/agents/{id}/collaboration"]
    e3["/agents/{id}/standing"]
    e4["/documents/{id} (+ /source)"]
    e5["/submissions/{id}/alignment"]
    e6["/nodes/{id}  (+ PATCH curation)"]
  end
  subgraph PANES["4-pane UI"]
    p1["Pane 1 — Collaboration standing"]
    p2["Pane 2 — What it proposes"]
    p3["Pane 3 — Ecosystem"]
    p4["Pane 4 — Mission alignment (placeholder)"]
    hw["'How this works' — provenance + curation controls"]
  end
  e2 --> p1
  e3 --> p1
  e4 --> p2
  e1 --> p3
  e4 --> p3
  e5 --> p4
  e6 --> hw
```

---

## 6. Runtime topology (SPEC §2.3)

Three services share SQLite + the blob store; the single worker does all heavy work and calls out to
the LLM and identity sources.

```mermaid
flowchart LR
  WEB["web — Next.js"] -->|HTTP| API["api — FastAPI (enqueues, serves)"]
  API --> DB[("SQLite<br/>submissions · documents · jobs ·<br/>agents · node_index · bundle_members")]
  WRK["worker — concurrency 1<br/>(ingest · extract · identity · link)"] --> DB
  API --> BLOB[("blobs (content-addressed)<br/>PDFs · docling.json · graph-LD · manifests")]
  WRK --> BLOB
  WRK -->|"Docling 2.99 (models prefetched)"| ING["PDF ingest + offset stream"]
  WRK -->|"swappable backend + fallback"| LLM["OpenRouter free → Mistral / Anthropic (opt-in paid)"]
  WRK -->|"identity + papers"| OA["OpenAlex (api key) + ORCID public API"]
```

---

## 7. Status axes & the curation lifecycle (SPEC §4.8, §8.4)

The three axes are **independent** (never one score). Curation is the human-in-the-loop path; a future
ATProto "claim" is just a curation event signed by a verifiable DID.

```mermaid
flowchart LR
  subgraph AXES["three independent status axes on every node"]
    EP["epistemic:<br/>hypothesis · claim · assumption · definition · observation"]
    AM["activity_modality:<br/>proposed · in_progress · completed"]
    CU["curation lifecycle ↓"]
  end
  subgraph CUR["curation_status"]
    s1["ai_extracted"] -->|human or DID-claim| s2["in_review"]
    s2 -->|verify| s3["expert_verified"]
    s2 -->|reject| s4["rejected (kept, not deleted)"]
    s1 -->|"grounding unverified / low conf"| s2
  end
```

---

_See `SPEC.md` for the authoritative detail and `schema/mira_x.yaml` for the verified overlay._
