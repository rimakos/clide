# Workspace

This file is the entry point Claude loads for every session in this workspace.
Copy it to your workspace root (the folder holding your repo checkouts and the
`wiki/` directory), then edit the placeholders.

@wiki/CLAUDE.md

## Starting a ticket

1. Read `wiki/index.md` first, then drill into the linked repo/seam/feature pages.
2. Run `/ticket-impact` before writing a plan or any code. It reads the wiki and
   `os-config.yaml`, surfaces hidden scope, and (for repos that declare a
   `rules_dir` in `os-config.yaml`) routes to that repo's own rules.
3. For contract, schema, or multi-repo tickets, follow
   `wiki/workflows/spec-driven-cross-repo-ticket.md`.

## Ending a session

Run `/wrap`. It patches corrections, files learnings to the wiki, updates the
index, and appends `log.md` (written LAST). The SessionStart hook
(`.claude/hooks/drift-check.sh`) warns the next session if `/wrap` was skipped.

## Operating rules the flow assumes

The full working rules (evidence ranking, verification before done, scope
discipline, PR-by-SHA, no-duplication) live in `wiki/CLAUDE.md`. The ones that
govern how work is executed, not just recorded:

- **Never commit or push.** No `git add` / `commit` / `push` unless the human
  explicitly says so in the current request. The agent scopes, implements,
  reviews, and captures. The human integrates.
- **Subagent-driven execution.** Delegate task implementation to spawned
  subagents; the main agent orchestrates, reviews, and tracks state. Group
  coupled tasks into one subagent; parallelize independent ones. After each task,
  drift-check against the plan before continuing.
- **Surgical changes.** Every changed line traces to the request. No drive-by
  refactors, renames, or cleanups. Match existing style.
- **Verify before done.** After multi-file changes, run build plus tests, report
  results, then declare complete. A fix is not done because it compiles.
