---
name: ticket-testing
description: >-
  Manually verify a ticket end-to-end on a running environment by driving the real
  app with Playwright MCP and reconciling every UI value against the read-only DB.
  Use when the user says "test this ticket", "manually test PROJ-1234", "verify this
  ticket in the app", "playwright test this story", or runs /ticket-testing. Always
  reads the ticket comments first (decisions, already-caught bugs, regressions). Picks
  existing test data from the DB (does not fabricate it, hands off to seed-test-data
  when the precondition data is missing). Never modifies the DB, never posts to the
  ticket source, never commits.
---

# ticket-testing

## Purpose
Prove a ticket actually works on a running environment: read its acceptance criteria
AND its comment thread, find real test subjects in the read-only DB, drive the app with
Playwright, and check each on-screen value (numbers, colors, tooltips,
presence/absence) against a DB query. Output a pass/fail table plus a ticket comment in
the user's voice.

Resolve the environment from `os-config.yaml` (or env vars): the app base URL and the
read-only DB connection. The ticket source is `{{ticket_source}}` from `os-config.yaml`
(Jira / Linear / GitHub / Azure DevOps / Shortcut / ...); read the ticket through
whatever integration that implies.

## When to use
- Slash command: `/ticket-testing`
- Natural language: "test this ticket", "manually test PROJ-1234", "verify this ticket
  in the app", "playwright test this story", "re-test this story like last time".

Do NOT use to seed/fabricate precondition data. That is `seed-test-data`.
Do NOT use for unit/integration tests in the repo. That is normal test tooling.

## Inputs
**Required**
- Ticket ID or URL.

**Optional**
- A specific entity (id or name) to test against; otherwise auto-pick from DB.
- Env base URL (default: the app URL in `os-config.yaml`).

## Workflow
Keep context tight: read only the ticket and the specific DB rows/screens you need. No
repo-wide scans, no Explore agents.

1. **Read the ticket AND every comment.** Via your ticket source's integration —
   fetch the full thread, not just the description. Build an explicit check list from
   THREE sources:
   - acceptance criteria in the description;
   - **every comment**. These carry the real signal: a reviewer reporting a bug
     ("X isn't included in Y"), a decision/clarification that overrides the description
     ("drop the fees line for now"), a side effect on another surface ("this also broke
     Z"), and a dev replying "fixed in the latest PR" (= confirm it, don't assume);
   - the linked PRs (scope of what changed).
   Treat each "X shouldn't show on Y" / "X is missing from Y" comment as its own
   regression check. A decision in a comment WINS over the original description when they
   conflict, note the conflict in the output.

2. **Plan test subjects.** From criteria + comments decide what data shapes you need:
   the happy path, each regression surface named in a comment, and the boundary cases
   (positive vs negative, empty vs populated, each entity type the change touches). One
   subject can cover several checks.

3. **Find subjects in the read-only DB.** Discover schema with `INFORMATION_SCHEMA`,
   then query for existing rows that match each shape. Capture the ids needed to build
   app URLs. If no row matches a needed shape, say so and offer to hand off to
   `seed-test-data` rather than forcing a weak test. Do NOT fabricate data here.

4. **Open the app with Playwright MCP.** Navigate to a target URL. A persisted login
   usually carries across sessions. If the page renders authenticated, proceed. If it
   lands on a login screen, PAUSE and ask the user to log in, then continue (the user
   does auth; the skill never handles credentials).

5. **Read the UI precisely.** `browser_snapshot` for structure/headings/labels.
   `browser_evaluate` for values the a11y tree omits: chart tooltips (dispatch
   `pointerover`/`pointermove`/`mouseover`/`mousemove` on the element, then read the
   tooltip text in a *separate* call so the framework can render), computed colors
   (`getComputedStyle(el).color`), and presence/absence of an element.

6. **Reconcile UI vs DB.** For each criterion, compute the expected value from a DB query
   and compare to the UI. Verify the regression surfaces (the thing that should NOT
   appear) and the negative/edge case (e.g. a subject where a value goes negative → red).
   Watch for unit transforms (e.g. monthly value × 12 = annual displayed). Record every
   comparison as ✓ or ✗ with both numbers.

7. **Emit results + draft comment.** Output the results table and a ticket comment
   written in the user's first-person voice (short, no internal jargon, ready to paste).
   Note anything not tested and why (e.g. a change that would need a DB/config mutation,
   and the DB is read-only). Stop. Never post, never commit.

## Running the DB helper
Query the DB through a **read-only, SELECT-guarded helper**, not an arbitrary SQL
client. The reference setup is a tiny script that connects with the caller's cloud
identity (e.g. an `az`/`gcloud`/`aws` token or an env connection string) and refuses
anything that is not a single `SELECT` / `WITH` / `SET` statement, so it structurally
cannot mutate data. Resolve the connection (host, database, auth) from `os-config.yaml`
or an env var; do not hardcode it here.

If the helper needs network egress the sandbox blocks (DNS to the auth endpoint and the
SQL host), run that Bash call with `dangerouslyDisableSandbox: true`. If your workspace
has no such helper yet, create a minimal SELECT-only wrapper once and point this skill at
it. Never grant this skill write access to the DB.

## Output template
```markdown
## Test results — PROJ-<id> (env, Playwright + DB reconciliation)

**Checks derived from:** <N criteria + M comments> (note any comment that
overrides the description).

**<Subject name / id>** — <one-line scope>
| Criterion (source) | UI value | DB-derived expected | ✓/✗ |
|---|---|---|---|
| <criterion> (desc / comment by X) | <ui> | <db calc> | ✓ |

**Regression / edge** — <subject>: <what was asserted> ✓/✗

**Not tested:** <item + why>

---
Draft comment (your voice):
> <first-person, concise, paste-ready>
```

## Hard rules
- **Read the comments before testing.** The comment thread is where decisions change and
  already-caught bugs live; never skip it. A comment decision overrides the description on
  conflict.
- **DB is read-only.** Only ever use the SELECT-guarded helper. Never run any other tool
  against the DB, never write/seed/mutate. If seeding is needed, hand off to
  `seed-test-data`.
- **Never post to the ticket source** and **never commit/push.** Output the draft
  comment; the user posts it.
- **The user does authentication.** Reuse a persisted session; if login is needed, pause
  and ask. Never handle credentials.
- **Reconcile, don't eyeball.** Every reported pass must be backed by a DB number or an
  explicit DOM read, not a screenshot impression.
- Stay scoped to the ticket. No repo-wide scans, no Explore agents, no fetching unrelated
  screens.
- Stop after the results table + draft comment.

## Anti-patterns
| Don't | Do |
|---|---|
| Skip the comment thread | Read every comment; each is a decision or regression check |
| Follow the description when a comment overrides it | Let the latest decision win; note the conflict |
| Assume "fixed in latest PR" means done | Re-verify the fix on the running env |
| Trust the screen looks right | Reconcile each value against a DB query |
| Mutate data to test a refresh/side effect | Note it as not-tested; recommend a manual poke |
| Run arbitrary SQL tools | Use the SELECT-guarded helper only |
| Read a chart tooltip in the same eval that triggers it | Dispatch hover, then read in a separate call |
| Fabricate missing precondition data | Hand off to `seed-test-data` |
| Post the comment / commit | Hand the draft to the user |

## Example usage
```
/ticket-testing PROJ-1234
```
Reads the ticket + all comments. The comments reveal: a value missing from one summary
element (bug), a line that should be dropped from a comparison view (decision, overrides
the description), and a side effect on a second entity type marked "fixed in latest PR".
Picks from the DB: a happy-path record, a second-type record (regression), and a record
where the value goes negative (red case). Drives each screen with Playwright, checks the
numbers, tooltip lines, and color against DB-derived values (watching for unit transforms
like annual = monthly × 12), emits the results table and a paste-ready comment. Stops.
```
