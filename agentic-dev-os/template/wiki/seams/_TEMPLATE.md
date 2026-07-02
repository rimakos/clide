---
tags: [seam]
date: YYYY-MM-DD
status: seed
---
# Seam: <name> (<repoA> ↔ <repoB>)

Topology: [[system-map]]. Mechanism: <REST / message bus / shared DB / ...>.
Contract: <OpenAPI / event schema / ...>. ⬜

## Rules
<!-- The cross-repo invariants that break things when violated.
     Precision, serialization, ownership, contract-regen steps. Evidence-tagged. -->
- ⬜ (none captured yet)

## Known traps
- Negative grep never proves a boundary is unused — generated clients and
  subscriptions hide call sites. Cite positive evidence before claiming "unused".

## Links
<!-- [[repoA]] · [[repoB]] -->
