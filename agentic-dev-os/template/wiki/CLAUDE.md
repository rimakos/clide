# wiki — Schema

This directory is an LLM-maintained knowledge base for your workspace. The LLM
writes and maintains it; the human curates sources and asks questions. It is the
memory that makes every ticket cheaper than the last.

**Work-only.** Personal content never lives here.

## Layers

- `raw/` — immutable sources (ticket exports, PR feedback, captured payloads,
  meeting notes). Read, never modify.
- Wiki pages — everything else in this directory. The LLM owns them.
- This file — the schema: conventions, operations, working rules.

## Conventions

- Pages start with YAML frontmatter:
  `tags` (list), `date` (created), `status` (`seed | active | stale`).
- Cross-reference with `[[wikilinks]]` (file names, so any wiki/graph tool resolves them).
- Every factual claim carries an evidence tag:
  - ✅ **Confirmed** — file:line, DB row, or captured payload.
  - 🟡 **Inferred** — derived from confirmed evidence.
  - ⬜ **Unknown** — not verified. Reserve for things genuinely unanswerable from
    the repos (product calls, prod-only behavior). Don't park ⬜ where a grep answers it.
- **No duplication:** repo/seam topology lives ONLY in [[system-map]]. Wiki pages
  hold working knowledge (commands, gotchas, conventions, links) and link to the map.
- Page types: `wiki/repos/<repo>.md`, `wiki/seams/<seam>.md`,
  `decisions/NNNN-*.md` (ADRs via the `goal` skill), `features/<ticket>-*.md`,
  `workflows/*.md`.

## Operations

**Ingest** (skill: `wiki-ingest`) — new source lands in `raw/` -> read it ->
discuss key takeaways -> update every wiki page it touches -> update `index.md` ->
append `log.md`. Flag contradictions with existing pages instead of silently overwriting.

**Query** — read `index.md` first, drill into linked pages, answer with citations.
Answers worth keeping get filed back as wiki pages (then index + log). Explorations
compound; nothing valuable dies in chat history.

**Lint** (skill: `wiki-lint`) — periodic health check: contradictions between pages,
claims superseded by newer sources, orphan pages (no inbound links), concepts
mentioned 3+ times without a page, missing evidence tags, index/log drift. Output a
fix list; apply only after the human confirms.

## Working rules

### Repo targeting (top recurring failure)
- Confirm which repo owns a change BEFORE editing. If ambiguous, name the candidate
  repo and wait. Watch for same-named libraries in different ecosystems (a backend
  package vs a frontend package of a similar name).
- Endpoints/classes named after another service may still be owned by the backend of
  record — check where the code lives, not what it's named.
- Check branch freshness before rebasing — verify the change isn't already merged.

### Verification before done
- After multi-file changes: run build + full test suite, report results, only then
  declare complete or prep a commit message.
- A fix is not "done" because it compiles — the failure mode is fixes that introduce
  regressions. Write/run the verifying check first when possible.
- **Verify before you write it.** When unsure about a fact (a field exists, a fix
  shipped, a gap closed), grep the repos to settle it BEFORE writing the page.
  Reserve ⬜ for the genuinely unanswerable.

### UI work
- Match the reference screenshot exactly. Map each element to an existing component
  before coding. Add nothing that is not in the reference.

### PR review
- Verify EVERY finding against the actual codebase; drop false positives; report only
  truly-needed fixes with a go/no-go verdict.
- **Read PR content by SHA, never the working tree.** Fetch the source and target
  refs, then diff `<target>...<source>` / show `<source>:path`. A bare read of a repo
  file returns whatever branch is checked out (usually the default) — stale text
  masquerading as the PR. Working-tree reads only for files NOT in the diff.

### Maintenance habits
- **Failure -> patch.** When a skill/page leads you wrong, patch it the same session
  so the failure cannot recur.
- **End-of-session review** (skill: `wrap`) — what did the human correct? What context
  was missing? Patch the relevant page or this schema before closing. Write `log.md` LAST.
- **Deterministic beats judgment.** Repeatable work becomes a workflow/skill; agent
  judgment is reserved for genuine decisions.

### Repo-local rules (optional)
- A repo may carry its own agentic-rules directory (see `repo_local_os` in
  `os-config.yaml`). When working in such a repo, `ticket-impact` routes to the exact
  files instead of loading the whole tree. That directory is authoritative for that
  repo's conventions; this wiki only points to it.

### Inherited discipline
- Evidence ranking: production data / payloads / logs > code > docs. Negative grep is
  never conclusive (generated clients, DI, message subscriptions hide call sites).
- Targeted searches only; no broad scans across repos.
- Do not modify any repo unless explicitly named; check `git status` in the target
  repo first.
- No git actions (stage/commit/push/branch) unless explicitly told.
- Scope discipline: no drive-by refactors, renames, cleanups.

## Navigation

- `index.md` — catalog of every page, one line each. Update on every ingest.
- `log.md` — append-only chronology. Entry format:
  `## [YYYY-MM-DD] <op> | <title>` where op ∈ ingest | query | lint | decision |
  feature | restructure. Greppable: `grep "^## \[" log.md | tail -5`.

## Precedence

`system-map.md` wins on topology. Production evidence wins over the map (then fix the
map). This file wins on conventions and workflow.
