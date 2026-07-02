# The flow

The whole methodology in prose. Open `visualiser.html` in a browser for the
clickable version.

## The idea

A multi-repo dev team keeps paying the same tax: every ticket rediscovers the same
topology, the same seam gotchas, the same "oh, this also touches the generated
client". agentic-dev-os removes that tax by running every ticket through one loop
and writing what it learns into a shared wiki, so the next ticket is cheaper.

Two halves:

1. **The lifecycle skills** — the loop below, as `/commands`.
2. **The knowledge wiki** — a config-driven, LLM-maintained knowledge base the
   skills read before scoping and write after finishing.

Nothing in here is tied to a product or domain. Skills resolve your repos, seams,
and ticket source from `os-config.yaml`.

## The loop

**1. Ticket arrives.** The raw ask. Work does not start in the editor.

**2. `/ticket-impact`** (before any plan or code). Produces a compact impact-aware
pre-plan and an Implementation Handoff: the hidden scope (validators, generated
clients, cloning paths, edge cases), the likely reviewer comments, and a Cross-repo
mini-spec when a seam is touched. If the target repo carries its own local rules
directory (declared in `os-config.yaml` under `repo_local_os`), it routes to the
exact files instead of loading the whole tree. The point: catch wider-scope ripple
now, not as PR comments later.

**3. Cross-repo spec** (only when a contract, data shape, or multiple repos are
touched). State the invariant in one or two sentences before opening a file. Rank
your evidence. Fill the system touch map: every repo and seam marked touched or not,
with a line of positive evidence for the untouched ones. Single-repo tweaks skip
this.

**4. Plan.** Scoped to exactly the surfaces impact analysis flagged. The plan
inherits the blast radius, so it does not forget the migration or the client regen.

**5. Implement (subagent-driven).** Coupled tasks run in one agent; independent
tasks fan out to parallel agents; the main agent orchestrates and drift-checks after
each task. Never commits or pushes. The human does that.

**6. Review.** `/cross-repo-review` checks the diff against the stated invariant and
touch map. `/pr-ticket-review` maps each ticket requirement to the diff (satisfied /
partial / missing) and flags cross-repo ripple. `/cross-repo-manual-test` builds an
invariant-anchored manual test guide. All of them read PR content by SHA, not the
working tree, and verify every finding against the codebase before anything is
posted.

**7. `/ticket-testing`.** Drives the real app (Playwright MCP) and reconciles every
UI value against the read-only database. Picks existing test data; hands off to
`/seed-test-data` when the precondition state does not exist. A fix is not done
because it compiles. Never modifies the DB, never posts, never commits.

**8. Capture.** `/wrap` runs the fixed closing checklist: corrections patched, facts
filed to the wiki, index updated, log appended (log written last). `/goal` writes a
compact ADR when a decision would surprise a future reader. This is the step that
makes the loop compound.

**9. The knowledge wiki.** index, log, system-map, per-repo and per-seam pages,
decisions, features. Every claim carries an evidence tag: ✅ confirmed (file:line,
data row, payload) / 🟡 inferred / ⬜ unknown. `/ticket-impact` reads it first on the
next ticket, closing the loop.

## Supporting skills

- `/wiki-ingest` — file a new source (ticket export, PR feedback, payload, meeting
  note) into the wiki; update every page it touches, the index, and the log.
- `/wiki-lint` — periodic health check: contradictions, stale claims, orphan pages,
  missing evidence tags, index/log drift. Fix list only, applied after you confirm.
- `/skill-workshop` — turn a repeatable piece of work into a new skill (design
  proposal first, SKILL.md after approval).
- `/mcp-impact` — decide, at the end of a branch, whether the change warrants MCP
  tooling. Reuse-first, safety-gated, never writes MCP code.
- `/seed-test-data` — seed precondition rows directly in SQL so a tester lands at the
  test point. Pairs with `/ticket-testing`.

## The rules that hold everywhere

- **Evidence ranking:** production data / payloads / logs > code (file:line) > docs.
  Negative grep is never conclusive; generated clients, DI, and message
  subscriptions hide call sites.
- **No commit/push by the agent.** Ever. The human integrates.
- **Targeted search only.** No broad repo-wide scans.
- **Scope discipline.** No drive-by refactors, renames, or cleanups.
- **Read PRs by SHA,** not the checked-out branch.
- **Failure leads to a patch.** When a skill or page steers you wrong, fix it the
  same session so the failure cannot recur.
