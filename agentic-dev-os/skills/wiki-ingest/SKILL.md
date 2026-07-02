---
name: wiki-ingest
description: Use when a new source (ticket export, PR feedback, captured payload, meeting note, article) should enter the workspace wiki, filing it into raw/, updating every wiki page it touches, the index, and the log. Triggers on /wiki-ingest, "ingest this into the wiki", "file this source", "add this to the wiki".
---

# wiki-ingest

Ingest one source into the workspace wiki (the `wiki/` directory).
Schema and conventions: `wiki/CLAUDE.md`. Read it first.

## Workflow

1. **Land the source.** If not already under `raw/`, copy it there
   (kebab-case filename, date-prefixed: `raw/2026-06-10-<slug>.md`).
   `raw/` is immutable. Never edit a landed source.
2. **Read it fully.** Extract: claims (with evidence rank), affected
   repos/seams, contradictions with existing pages, decisions implied.
3. **Discuss takeaways** with the user in 3-6 bullets BEFORE writing.
   Skip discussion only if the user said "batch" or "just file it".
4. **Update wiki pages.** Touch every page the source affects
   (`wiki/repos/`, `wiki/seams/`, occasionally `system-map.md` for
   topology, keeping its ✅/🟡/⬜ tags). Flag contradictions explicitly:
   add the new claim + tag, demote the old one; never silently overwrite.
5. **Update `index.md`**: new pages get a line; changed one-liners get
   corrected.
6. **Append `log.md`**: `## [YYYY-MM-DD] ingest | <source title>` + 2-4
   bullets (what changed, which pages).
7. **Echo** the list of touched files. Stop. No git actions.

## Hard rules
- Work-only wiki: personal content is refused. Point the user to their
  personal vault.
- Evidence tags on every new claim.
- Topology lives in system-map.md only; wiki pages link, don't duplicate.
