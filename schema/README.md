# schema/ — the MIRA schema binding

The output contract of this tool **is the MIRA community schema** — no
extension overlay, no local vocabulary. This directory pins the schema by
commit and proves the tool's output against the schema repo's own generated
SHACL shapes.

| Path | Tracked? | What |
|---|---|---|
| `Makefile` | ✅ | `vendor` (fetch the pinned schema files), `validate` (SHACL-check the fixture), `clean`. |
| `validate.py` | ✅ | pyshacl validation of any `*.mira.jsonld` against `vendor/mira.shacl`, offline (the published `@context` PURL is resolved from the vendored copy). |
| `vendor/SOURCE.txt` | ✅ | The pinned MIRA commit + fetch instructions. |
| `vendor/*` | ❌ (gitignored) | The vendored schema files. Reproduce with `make vendor`. |

## Quickstart

```bash
pip install pyshacl          # pulls rdflib
cd schema
make vendor                  # fetch the pinned MIRA schema into vendor/
make validate                # SHACL-validate ../examples/sample.mira.jsonld
```

`validate.py` exits 0 only when a document conforms. Validate your own
extraction with `python validate.py path/to/paper.mira.jsonld`.

## Known generated-shape quirks (at the current pin)

The schema is a living draft and its SHACL is generated from LinkML; at the
pinned commit the generator renders some slot metadata as `sh:in` value lists
that no IRI value can satisfy (on `dgb:source`, `dgb:destination`, and
`mira:sourceDocument`). The schema repo's own `sampleData.json` trips the same
shapes. `validate.py` downgrades exactly these, and only these, to printed
warnings — every other violation fails the run. When the pin moves, re-check
whether the quirks still exist and trim the list.

Two modeling notes encoded in `validate.py` (see its docstring): validation
adds the `dgb:NodeSchema` mixin type the LinkML source declares for every node
class (the shapes check it on relation endpoints), and deliberately does NOT
add the full supertype closure (typing a Study as `prov:Activity` would trip
the closed `prov:Activity` shape — an upstream shapes tension worth raising
with the schema maintainers).
