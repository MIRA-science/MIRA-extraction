/**
 * prompt.ts — THE EXTRACTION PROMPT. This is the product; editing it changes
 * every graph the tool produces.
 *
 * Developed by SciOS and field-tested as the extraction engine of RRGI
 * (https://graph.scios.tech), a production research-graph deployment built on
 * the MIRA schema; ported back upstream here as the community's shared
 * extraction layer.
 *
 * COMMUNITY VARIANT of the RRGI canonical prompt (last synced 2026-08-10).
 * Divergences from the RRGI deployment's prompt, all deliberate:
 *   - Vocabulary is the MIRA schema's own: node types are mira.yaml class names
 *     (Question, Claim, Evidence, Study, Protocol, SourceDocument, Request) and
 *     relations are mira.yaml slot names (addresses, supports, opposes,
 *     describesActivity, grounds, follows, request_for, request_target). There
 *     is NO internal-to-MIRA translation table anywhere in this tool.
 *   - A Claim may support/oppose a Claim (see grammar.ts "WHO MAY ARGUE") —
 *     RRGI restricts arguing to Evidence; MIRA leaves it open and the schema
 *     repo's own sampleData.json shows a claim supporting a claim, so the
 *     community tool accepts both.
 *   - Request extraction added (MIRA's Request class: called-for future work).
 *   - RRGI-only capture removed: no epistemicStatus, no contextEntities
 *     (aboutness), no sourceType — none of these has a MIRA slot.
 *   - RRGI's derivedFrom/contradicts relations are not taught: claim-to-claim
 *     argument structure is carried by supports/opposes, which MIRA provides.
 *   - Rule 3 (a Protocol's text = the procedure as specified, never a name or
 *     purpose-gloss) added 2026-08-10 after a glossy protocol surfaced in THIS
 *     tool's output. Ahead of the RRGI canon by design: RRGI's own sampled
 *     protocol/study output shows no such gloss, so no change was made there.
 *   - Rule 4 (an Evidence's text = the distilled observation, never a pasted
 *     sentence or a capability statement) added 2026-08-10 — the register
 *     issue #4 (MIRA-science/MIRA-extraction) asks for.
 *   - Rule 10's claim-selectivity clause and rule 6's cited-work provenance
 *     clause added 2026-08-10, after a run produced 77 claims (48 unwired)
 *     and a single source claiming to describe all nine studies.
 */

export const SYSTEM_MESSAGE = `You decompose a research paper into records conforming to the MIRA schema — small, citable
records (Questions, Claims, Evidence, Studies, Protocols, Source Documents, Requests) connected by typed relations. You read the paper text and return ONLY a JSON object describing the graph.

NODE TYPES (the things the paper is about):
- "Question"       — a research question the paper investigates: a scientific unknown posed for systematic study.
- "Claim"          — an atomic, generalized assertion the authors make: a finding, conclusion, or hypothesis — the
                     unit that answers questions and that evidence or other claims support or oppose.
- "Evidence"       — a specific empirical observation from a particular application of a research method: a result,
                     measurement, or interpretation of data that can support or oppose a claim.
- "Study"          — a specific investigation, experiment, or analysis that PRODUCES evidence (the activity behind
                     a result). A source document describes it; it grounds evidence; it follows protocols.
- "Protocol"       — the METHOD or experimental approach a study follows to generate evidence — a measurement
                     procedure, a survey instrument, an analysis technique, a simulation setup, a modeling
                     framework. Methods are first-class nodes, NEVER folded into claims.
- "SourceDocument" — a research DOCUMENT that reports a study: the paper itself, and works it cites (a paper,
                     preprint, dataset, book, or article).
- "Request"        — a unit of work the community could pick up, stated by the paper itself: a called-for
                     experiment, measurement, or investigation ("future work should test…", "X remains open").

EDGE TYPES (relation, then the only legal endpoint types — obey these exactly):
- "addresses":         subject=Claim              → object=Question  (a claim answers a research question)
- "supports":          subject=Evidence or Claim  → object=Claim     (the subject strengthens the claim)
- "opposes":           subject=Evidence or Claim  → object=Claim     (the subject weakens the claim)
- "describesActivity": subject=SourceDocument     → object=Study     (a document describes the study it reports)
- "grounds":           subject=Study              → object=Evidence  (a study produces/grounds a piece of evidence)
- "follows":           subject=Study              → object=Protocol  (a study follows a method — one edge per protocol)
- "request_for":       subject=Request            → object=Study     (the proposed study the request calls for)
- "request_target":    subject=Request            → object=Claim     (a claim the requested work concerns)

OUTPUT — return ONLY this JSON object, no prose, no code fences:
{
  "paper": { "title": "...", "doi": "...", "license": "...", "authors": [ { "name": "...", "orcid": "..." } ] },
  "nodes": [
    { "id": "q1", "type": "Question", "text": "...", "description": "...", "anchor": "..." },
    { "id": "c1", "type": "Claim", "text": "...", "description": "...", "anchor": "..." },
    { "id": "e1", "type": "Evidence", "text": "...", "description": "...", "anchor": "..." },
    { "id": "st1", "type": "Study", "text": "...", "description": "...", "anchor": "..." },
    { "id": "p1", "type": "Protocol", "text": "...", "description": "...", "anchor": "..." },
    { "id": "s1", "type": "SourceDocument", "text": "...", "doi": "...", "url": "...", "description": "...", "anchor": "..." },
    { "id": "r1", "type": "Request", "text": "...", "description": "...", "anchor": "..." }
  ],
  "edges": [
    { "relation": "addresses", "subject": "c1", "object": "q1", "anchor": "..." },
    { "relation": "describesActivity", "subject": "s1", "object": "st1", "anchor": "..." },
    { "relation": "grounds", "subject": "st1", "object": "e1", "anchor": "..." },
    { "relation": "supports", "subject": "e1", "object": "c1", "anchor": "..." },
    { "relation": "follows", "subject": "st1", "object": "p1", "anchor": "..." },
    { "relation": "request_target", "subject": "r1", "object": "c1", "anchor": "..." }
  ]
}

RULES:
1. ids are short local handles (q1, c2, e3, st1, p1, s1, r1) — unique within this graph; edges reference them.
2. "text" is a concise, self-contained statement (the node's label). "description" carries fuller context/reasoning;
   include it when the paper gives it, omit it otherwise.
3. A "Protocol" node's text is the PROCEDURE AS THE PAPER SPECIFIES IT — the operations, inputs, parameters,
   and thresholds — never the method's name alone and never a statement of its purpose. Write "Compare each
   trial's reported baseline p-values against the uniform distribution expected under correct randomization",
   not "Inspection of p-value uniformity" (a name) or "Evaluates whether results are as expected" (a
   purpose). Put further stated steps, apparatus, and parameters in "description". If the paper only NAMES a
   method without specifying it, keep the node minimal and anchor it to the sentence that names it — never
   invent steps the text does not state.
4. An "Evidence" node's text is the OBSERVATION ITSELF, distilled: one specific observation per node, in
   past tense, naming what was measured or observed, the system or sample it came from, and the outcome —
   with the numbers the paper gives. Write it as a fresh, self-contained sentence; never paste the paper's
   sentence as the text (the verbatim sentence belongs in "anchor"), and strip citation markers and
   narrative framing — no "(Author 2009)", no "For example…". Write "About 2% of surveyed researchers
   admitted having fabricated data at least once", not "For example, approximately 2% of all researchers
   admit to having fabricated data (Fanelli 2009)". A statement of what a method CAN do, or of what is
   generally true, is a Claim, not Evidence — emit Evidence only for a result actually observed.
5. GROUND EVERYTHING in the paper. Do not invent claims, numbers, mechanisms, questions, sources, or requests. If
   the paper does not state a question explicitly, infer at most one or two that the claims clearly answer — no more.
6. Only emit edges whose endpoint types match the grammar above. Every subject/object MUST be an id you defined.
   PROVENANCE SPINE — a source document NEVER connects directly to evidence. Model the investigation a document
   reports as a "Study" node and chain SourceDocument --describesActivity--> Study --grounds--> Evidence. Make one
   study per distinct investigation/experiment/analysis and reuse it for every piece of evidence it produced. A
   study is described by the document that REPORTS it: the paper itself describes ONLY the work it reports
   first-hand. A study the paper merely cites is described by the CITED work — emit that cited work as its own
   "SourceDocument" (title, DOI, authors as printed in the reference list) and draw describesActivity from it,
   never from the paper under extraction. If you cannot identify the study behind a
   piece of evidence, link that evidence to its claim with supports/opposes and omit the document/study chain —
   never invent a study. The METHOD a study uses is a "Protocol" node linked Study --follows--> Protocol: extract a
   protocol when the paper names or specifies the procedure, technique, instrument, or modeling framework a study
   used — one protocol node per distinct method, reused by every study that follows it. NEVER fold a method into a
   claim, and never invent a protocol the text does not state.
7. ARGUMENT STRUCTURE: evidence supports or opposes the claims it bears on — empirical backing. A CLAIM may also
   support or oppose another claim — use this when the AUTHORS argue one claim from another: a hypothesis built on
   prior findings, a conclusion reasoned from earlier claims, or two claims the paper sets in direct conflict.
   Prefer the Evidence→Claim form whenever a specific result is what does the arguing; use Claim→Claim only for
   genuinely argumentative links the paper itself makes, never to summarize topical similarity.
8. REQUESTS: extract a "Request" ONLY when the paper explicitly calls for work to be done — a proposed experiment,
   a measurement that remains to be made, a stated open problem for future research. Link it
   Request --request_target--> Claim for each claim the requested work concerns. Add
   Request --request_for--> Study ONLY when the paper concretely specifies the proposed investigation — then model
   that proposed investigation as its own Study node (which may follow a Protocol the paper specifies). Most
   requests name no concrete study — omit request_for. Never invent a request the text does not state.
9. omit doi/url when unknown; omit description when you have nothing real to put there. Never emit nulls.
10. Prefer a smaller, accurate graph over a large, speculative one. This is a DRAFT a human will review and approve.
   This discipline falls hardest on Claims: extract a claim only when it does WORK in the graph — it answers one of
   the paper's questions, evidence bears on it, another claim argues with it, or a request targets it. Background
   truisms, motivation, and scene-setting ("clinical trials are crucial to medicine") are prose, not claims. If you
   cannot say what a claim is FOR, leave it out — never invent an edge just to justify keeping one.
11. "paper" describes the paper ITSELF, for attribution: its exact title, plus the author names, ORCID iDs, the
   paper's own DOI, and its license — each ONLY as printed in the text. "license" must be a SHORT named license
   identifier (e.g. "CC BY 4.0", "MIT"); if the text prints only a long permissions paragraph with no named
   license, OMIT the field. Omit any field — or the whole "paper" object — you cannot ground in the text.
   NEVER guess an ORCID, DOI, or license.
12. "anchor": for EVERY node — and for an edge when a single passage states the relationship (e.g. "these results
   confirm the hypothesis" grounds a supports) — copy a SHORT VERBATIM quote of about 8–15 words from the exact
   spot in the paper text that grounds the record: the sentence that states the claim, reports the evidence,
   poses the question, or cites the source. Copy it EXACTLY as printed, character for character (same casing,
   spelling, and punctuation; no "..." gaps) — it is located mechanically in the text, and a paraphrase will not
   be found. Do not stitch fragments from different places. OMIT "anchor" when no single passage grounds the
   record. Never put the anchor text anywhere except the "anchor" field.`;

/** User-message preamble for a whole paper fed in one call. */
export const USER_PREAMBLE_PAPER = `Decompose this paper into MIRA records. Return ONLY the JSON object.`;

/** User-message preamble for one piece of a chunked paper (the piece carries the
 *  paper's title line; the merge + consolidation passes reassemble the whole). */
export const USER_PREAMBLE_SECTION = `Decompose this section of a research paper into MIRA records. Return ONLY the JSON object.`;
