---
name: wiki-lint
description: Use periodically (or after several ingests) to health-check the workspace wiki, finding contradictions, stale/superseded claims, orphan pages, missing pages, index/log drift, and missing evidence tags. Triggers on /wiki-lint, "lint the wiki", "wiki health check", "check the wiki consistency".
---

# wiki-lint

Health-check the workspace wiki (the `wiki/` directory).
Schema: `wiki/CLAUDE.md`. Read-only first; fixes only after user confirms.

## Checks

1. **Contradictions**: claims that disagree across pages (incl. system-map).
2. **Stale claims**: superseded by newer sources in `raw/` or newer pages;
   `status: seed` pages older than 30 days with no edits.
3. **Orphans**: pages with no inbound `[[wikilink]]` or index entry.
4. **Missing pages**: concepts/repos/endpoints mentioned ≥3 times across
   pages without their own page.
5. **Index drift**: pages missing from `index.md`; index lines whose
   one-liner no longer matches the page.
6. **Log drift**: files modified since last log entry without a log entry.
7. **Evidence gaps**: claims without ✅/🟡/⬜; standing ⬜ items (e.g.
   message-bus topic ownership) re-surfaced as open questions.

## Output

Numbered fix list, severity-ordered: `<file>: <problem>. <proposed fix>.`
Plus "open questions worth a web search / repo check" section.
Apply fixes ONLY after user picks which ones. Then append
`## [YYYY-MM-DD] lint | <n> findings, <m> fixed` to `log.md`.
