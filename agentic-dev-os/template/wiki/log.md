# Log

Append-only chronology. Newest at the bottom. One entry per operation.

Format: `## [YYYY-MM-DD] <op> | <title>`
where op ∈ ingest | query | lint | decision | feature | restructure.

Greppable: `grep "^## \[" log.md | tail -5`

<!-- Example:
## [2026-01-15] restructure | Initialized wiki from agentic-dev-os template
Seeded index, system-map, CLAUDE schema. Filled os-config.yaml with 3 repos, 2 seams.
-->
