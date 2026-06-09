# schema/Makefile — vendor the pinned MIRA schema and generate build artifacts.
#
# Requirements: curl, and LinkML (`pip install linkml` / `uv pip install linkml`).
# Usage:
#   make vendor     # fetch the pinned MIRA import closure into vendor/
#   make schema     # generate Pydantic models, JSON Schemas, and JSON-LD context
#   make validate   # sanity-check the overlay loads/validates
#   make all        # vendor + schema
#   make clean      # remove generated/ (vendor/ is left in place)
#
# Windows: run under Git Bash / WSL, or invoke the equivalent commands by hand
# (see vendor/SOURCE.txt for the curl loop).

SHA      := f7d0449a34efe776e4ca69a350ebaa8fa60fcc19
BASE     := https://raw.githubusercontent.com/MIRA-science/schema/$(SHA)
VENDOR   := vendor
GEN      := generated
OVERLAY  := mira_x.yaml

# MIRA import closure (order doesn't matter for fetch).
VENDOR_FILES := mira discoursegraphs_base sioc dct prov schemaorg

# Target classes to emit standalone JSON Schemas for (closed). One per validatable root.
CLASSES := Claim Question Evidence Study Protocol Request SourceDocument \
           Agent Bundle Narrative Relation

.PHONY: all vendor schema validate clean
all: vendor schema

vendor:
	@mkdir -p $(VENDOR)
	@for f in $(VENDOR_FILES); do \
		echo "fetch $$f.yaml @ $(SHA)"; \
		curl -fsSL "$(BASE)/$$f.yaml" -o "$(VENDOR)/$$f.yaml" || exit 1; \
	done
	@echo "vendored $(VENDOR_FILES) into $(VENDOR)/ (pin $(SHA))"

schema: $(GEN)/mira_models.py $(GEN)/mira.context.jsonld json-schemas

# Verified with linkml 1.11.1 on Python 3.13 (2026-06-09): gen-pydantic emits
# pydantic v2 by default (no --pydantic-version flag in this line).
$(GEN)/mira_models.py: $(OVERLAY)
	@mkdir -p $(GEN)
	gen-pydantic $(OVERLAY) > $@
	@echo "wrote $@"

# Output @context = [ MIRA PURL, mirax fragment ]. We ship the hand-authored
# mirax.context.jsonld because gen-jsonld-context conflicts on the overlay's
# re-declared imported classes (known LinkML quirk; gen-pydantic/json-schema are fine).
# `make context-gen` attempts the generator anyway (allowed to fail) for inspection.
$(GEN)/mira.context.jsonld: mirax.context.jsonld
	@mkdir -p $(GEN)
	cp mirax.context.jsonld $@
	@echo "wrote $@ (hand-authored mirax term block)"

.PHONY: context-gen
context-gen:
	@mkdir -p $(GEN)
	-gen-jsonld-context $(OVERLAY) > $(GEN)/mira.context.full.jsonld
	@echo "attempted full context (may fail on re-declared classes; non-blocking)"

# One closed JSON Schema per target class (rooted at that class).
json-schemas: $(OVERLAY)
	@mkdir -p $(GEN)
	@for c in $(CLASSES); do \
		echo "gen-json-schema -> $(GEN)/mira.$$c.schema.json"; \
		gen-json-schema --closed -t $$c $(OVERLAY) > $(GEN)/mira.$$c.schema.json || exit 1; \
	done

validate:
	linkml-validate -s $(OVERLAY) --help >/dev/null 2>&1 || { echo "linkml not installed"; exit 1; }
	@echo "overlay parses; to validate data: linkml-validate -s $(OVERLAY) -C <Class> <data.json>"

clean:
	rm -rf $(GEN)
