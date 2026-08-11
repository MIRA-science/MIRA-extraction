#!/usr/bin/env python3
"""Validate an extraction's MIRA JSON-LD against the vendored MIRA SHACL shapes.

Usage: python validate.py <file.mira.jsonld> [more files...]

What this does, and why:
  1. The document's @context references the published PURL
     (https://purl.org/mira-science/mira.jsonld); for OFFLINE validation the
     reference is swapped for the vendored copy (vendor/mira.jsonld, pinned by
     commit in the Makefile) before parsing.
  2. TARGETED mixin typing: the generated shapes check that dgb:source /
     dgb:destination values are dgb:NodeSchema instances. In the LinkML source
     every MIRA node class mixes in NodeSchema, but that mixin edge is not in
     the data, so the corresponding rdf:type triples are added here — for the
     seven node classes and RelationInstance ONLY. (Full supertype closure is
     deliberately NOT applied: typing a Study as prov:Activity would trip the
     closed prov:Activity shape — an upstream shapes tension.)
  3. KNOWN GENERATED-SHAPE QUIRKS are downgraded to warnings (printed, never
     hidden): the generator renders some slot metadata as `sh:in` value lists
     (e.g. sh:in ("rdf_subject") on dgb:source, sh:in ("RelationDef"
     "observationBase") on mira:sourceDocument), which no IRI value can ever
     satisfy — the community's own sampleData.json trips the same shapes.
     Every OTHER violation fails the run.

Exit 0 = conforms (possibly with known-quirk warnings). Exit 1 = real violations.
"""
import json
import re
import sys
from pathlib import Path

try:
    from pyshacl import validate
    from rdflib import Graph, RDF, URIRef
except ImportError:
    sys.exit("needs pyshacl: pip install pyshacl")

HERE = Path(__file__).parent
VENDOR = HERE / "vendor"
PURL = "https://purl.org/mira-science/mira.jsonld"

MIRA = "http://purl.org/mira-science/mira#"
DGB = "https://discoursegraphs.com/schema/dg_base#"
NODE_SCHEMA = URIRef(DGB + "NodeSchema")

# mira.yaml: every node class mixes in NodeSchema; RelationInstance does too.
NODESCHEMA_MIXERS = [URIRef(MIRA + c) for c in
                     ("Question", "Claim", "Evidence", "Study", "Protocol", "SourceDocument", "Request")] + \
                    [URIRef(DGB + "RelationInstance")]

# (constraint component, result path) pairs downgraded to warnings — the
# generated `sh:in` literal-list artifacts. Documented in schema/README.md.
KNOWN_QUIRKS = {
    ("InConstraintComponent", DGB + "source"),
    ("InConstraintComponent", DGB + "destination"),
    ("InConstraintComponent", MIRA + "sourceDocument"),
}


def load_data_graph(path: Path) -> Graph:
    doc = json.loads(path.read_text(encoding="utf-8"))
    vendored_ctx = json.loads((VENDOR / "mira.jsonld").read_text(encoding="utf-8"))["@context"]
    ctx = doc.get("@context")
    if isinstance(ctx, list):
        doc["@context"] = [vendored_ctx if c == PURL else c for c in ctx]
    elif ctx == PURL:
        doc["@context"] = vendored_ctx
    g = Graph()
    g.parse(data=json.dumps(doc), format="json-ld")
    for cls in NODESCHEMA_MIXERS:  # the targeted mixin typing (see module docstring)
        for s in list(g.subjects(RDF.type, cls)):
            g.add((s, RDF.type, NODE_SCHEMA))
    return g


def split_violations(results_text: str):
    """Partition the pyshacl report into (known-quirk, real) violation blocks."""
    known, real = [], []
    for block in results_text.split("Constraint Violation")[1:]:
        comp = re.search(r"in (\w+)", block)
        path = re.search(r"Result Path: <?([^>\s]+)>?", block)
        # normalize a prefixed path (e.g. mira:sourceDocument) to a full IRI
        p = path.group(1) if path else ""
        p = p.replace("mira:", MIRA).replace("dgb:", DGB)
        key = (comp.group(1) if comp else "?", p)
        (known if key in KNOWN_QUIRKS else real).append((key, block))
    return known, real


def main() -> int:
    files = [Path(a) for a in sys.argv[1:]]
    if not files:
        print(__doc__)
        return 2
    shacl = Graph()
    shacl.parse(VENDOR / "mira.shacl", format="turtle")
    failed = 0
    for f in files:
        data = load_data_graph(f)
        conforms, _, results_text = validate(data, shacl_graph=shacl, advanced=True)
        if conforms:
            print(f"{f}: CONFORMS ({len(data)} triples)")
            continue
        known, real = split_violations(results_text)
        if not real:
            quirks = sorted({f"{k[0]} on {k[1]}" for k, _ in known})
            print(f"{f}: CONFORMS modulo {len(known)} known generated-shape quirk(s) ({len(data)} triples)")
            for q in quirks:
                print(f"  warning (upstream shape quirk): {q}")
            continue
        print(f"{f}: DOES NOT CONFORM — {len(real)} real violation(s) (+{len(known)} known quirks)")
        for _, block in real[:20]:
            print("Constraint Violation" + block.rstrip())
        failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
