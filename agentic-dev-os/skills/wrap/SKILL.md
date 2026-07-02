---
name: wrap
description: End-of-session memory closer for workspace work. Runs the fixed checklist that feeds the workspace wiki: corrections patched, ADR considered, facts filed, index updated, log appended. Triggers on /wrap, "log this", "wrap up", "close the session", "store what we learned".
---

# wrap

End-of-session checklist. Always run ALL five steps in order. The wiki schema
is `wiki/CLAUDE.md`. **`wiki/log.md` is ALWAYS written last**. The SessionStart
drift check compares file mtimes against it.

## Steps

1. **Corrections sweep.** Scan this session for moments the user corrected
   you, a doc/skill misled you, or an assumption broke. Patch the offending
   wiki page / skill / schema NOW (the failure-to-patch rule). None found, say so.
2. **ADR check.** Did the session produce a non-obvious decision ("why this,
   not the alternative")? Yes: invoke `/goal`. Routine: skip with one-line
   reason. (Personal-project decisions never go here; those belong in a
   personal vault, not the workspace wiki.)
3. **Facts filing.** New durable knowledge (build command verified, gotcha
   discovered, ⬜ to ✅ promotion, contradiction found): update the right
   `wiki/repos/` / `wiki/seams/` page with evidence tags. Big source
   artifact (PR feedback, payload, post-mortem) goes to `raw/` + note that
   `/wiki-ingest` can process it fully.
4. **Index.** New/repurposed pages: `index.md` lines updated.
5. **Log LAST.** Append to `wiki/log.md`:
   `## [YYYY-MM-DD] <op> | <session title>` + 2-4 bullets (what changed,
   which pages). If steps 1-4 changed nothing, still append a one-bullet
   entry (`no memory changes: <reason>`), so the drift check resets.

## Output

5 lines max: one per step, what was written where (file paths), or "skipped:
<reason>". End with "Ready to commit: <files>" if the wiki is git-tracked.
No git actions.
