# schema/Makefile — vendor the pinned MIRA schema and validate output against it.
#
# This tool emits PURE MIRA (no extension overlay): the output contract IS the
# community schema, pinned by commit below and validated with the schema repo's
# own generated SHACL shapes.
#
# Requirements: curl, python3 with `pip install pyshacl` (pulls rdflib).
# Usage:
#   make vendor     # fetch the pinned MIRA schema files into vendor/
#   make validate   # pyshacl-validate ../examples/sample.mira.jsonld against vendor/mira.shacl
#   make clean      # remove vendor/ (reproduce with `make vendor`)
#
# Windows: run under Git Bash / WSL, or invoke the equivalent commands by hand
# (see vendor/SOURCE.txt).

SHA    := 483f0b21480c0f4ced9c1519fc0f6df2b8617cfe
BASE   := https://raw.githubusercontent.com/MIRA-science/schema/$(SHA)
VENDOR := vendor

# The LinkML import closure (documentation/reference) + the generated artifacts
# we validate with (mira.shacl) and resolve the published context from
# (mira.jsonld), + the community's own sample instance data (reference).
VENDOR_FILES := mira.yaml discoursegraphs_base.yaml sioc.yaml dct.yaml prov.yaml \
                schemaorg.yaml rdf.yaml mira.shacl mira.jsonld mira.ttl sampleData.json

.PHONY: vendor validate clean

vendor:
	@mkdir -p $(VENDOR)
	@for f in $(VENDOR_FILES); do \
		echo "fetch $$f @ $(SHA)"; \
		curl -fsSL "$(BASE)/$$f" -o "$(VENDOR)/$$f" || exit 1; \
	done
	@echo "vendored $(words $(VENDOR_FILES)) files into $(VENDOR)/ (pin $(SHA))"

validate: $(VENDOR)/mira.shacl
	python validate.py ../examples/sample.mira.jsonld

$(VENDOR)/mira.shacl:
	@echo "vendor/ is missing — run 'make vendor' first" && exit 1

clean:
	rm -rf $(VENDOR)
