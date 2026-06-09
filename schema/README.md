# schema/ — MIRA schema binding

The output contract for MIRA-extraction. We **track + validate against** the current MIRA LinkML
schema and keep our additions in one overlay; the overlay diff *is* the upstream proposal
(SPEC §5, §17). We do **not** build hot-swap machinery (Decision 22).

## Files

| Path | Tracked? | What |
|---|---|---|
| `mira_x.yaml` | ✅ | **The overlay.** Imports the vendored MIRA schema and adds the envelope (source span + provenance + 3 status axes), the identity layer (`Agent`, `affiliatedWith`, authorship), `Bundle`/`Narrative`, reified `Relation`, funder-side classes (`Criterion`/`Endorsement`/`Project`/`Grant`), and slot-attachment fixes. |
| `mirax.context.jsonld` | ✅ | Hand-authored JSON-LD term block for the `mirax:` extension. Output `@context = [ <MIRA PURL>, this ]`. |
| `vendor/SOURCE.txt` | ✅ | Pinned MIRA commit SHA + fetch instructions. |
| `vendor/*.yaml` | ❌ (gitignored) | The vendored MIRA import closure. Reproduce with `make vendor`. |
| `generated/` | ❌ (gitignored) | `gen-pydantic` models + closed JSON Schemas. Reproduce with `make schema`. |
| `Makefile` | ✅ | `vendor`, `schema`, `validate`, `clean` targets. |

## Quickstart

```bash
pip install linkml                  # or: uv pip install linkml   (verified: linkml 1.11.1)
cd schema
make vendor                         # fetch the pinned MIRA closure into vendor/
make schema                         # -> generated/mira_models.py, generated/mira.<Class>.schema.json, context
# validate a graph-LD document:
linkml-validate -s mira_x.yaml -C <RootClass> path/to/graph.json
```

## Status (verified 2026-06-09, linkml 1.11.1 / Python 3.13)

- ✅ `gen-pydantic mira_x.yaml` — generates (imports resolve; class-merge + slot-attachment work;
  `Claim(Grounded, Argument, NodeSchema)` carries `addresses` + envelope + refined `creator`; `Agent`,
  `Bundle`, `Narrative`, `Relation`, `Criterion` all resolve).
- ✅ `gen-json-schema --closed -t <Class>` — generates for every target class.
- ⚠️ `gen-jsonld-context` — **fails** ("Conflicting URIs … for item: Argument") because the overlay
  re-declares imported classes to attach slots (known LinkML quirk). **Non-blocking:** we ship the
  hand-authored `mirax.context.jsonld` instead; `make context-gen` attempts the generator for
  inspection only.
- ✅ `linkml-validate` — `Claim`, `Relation`, `Bundle`, `Agent` example instances (`examples/`) pass
  **closed** validation on the **slot-name model form**. Note: closed validation **rejects JSON-LD
  keywords** (`@id`/`@type`/`@context`) — the serializer adds those after validation, so validate the
  model form, not raw graph-LD. (`title` was added to the `Grounded` mixin after this check.)

## Pin

`main` @ `f7d0449a34efe776e4ca69a350ebaa8fa60fcc19`. To bump: edit the SHA in `vendor/SOURCE.txt`,
`Makefile`, and `../.env.example` (`MIRA_SCHEMA_SHA`), then `make vendor schema` and review the deltas.

## `# CALIBRATE:` markers in `mira_x.yaml`

Spots that may need adjustment as the schema/data evolve — search the file for `CALIBRATE:`
(e.g. the `curation_status` `ifabsent` syntax, the `Endorsement`/`Project` mixin simplification vs the
`proposals` branch, the `vendor/mira` import path).
