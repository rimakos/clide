---
name: ticket-impact
description: Use BEFORE writing a plan or any code on a new ticket. Produces a compact impact-aware pre-plan and Implementation Handoff so wider-scope concerns (validators, generated client, cloning paths, edge cases, likely reviewer comments) surface upfront instead of as PR comments. When the working repo carries its own repo-local rules directory, also routes to the right rule docs and follow-up skills. Triggers on /ticket-impact, "review this ticket before implementation", "analyze ticket impact", "scope this ticket", "find hidden scope", "pre-plan this ticket", "what could this affect", "before I start this ticket".
---

# ticket-impact

## Purpose

Catch wider-scope ripple effects of a ticket BEFORE planning starts, so they don't return as PR review comments. Produces a compact pre-plan + Implementation Handoff. **Stops there.** Does NOT invoke writing-plans, save files, or start implementation.

When the working repo carries its own repo-local rules directory (a repo listed under `repo_local_os` in `os-config.yaml`, detected by its `rules_dir` present at the repo root), the output also includes a compact **Repo-local rules routing** block: category, risk level, generated-client impact, recommended rule docs to load, and follow-up skills. **No duplication of the rule docs' content** (paths only).

## When to use

Invoke when starting work on a ticket, before any plan or code:
- `/ticket-impact` slash command
- "review this ticket before implementation"
- "analyze ticket impact" / "scope this ticket"
- "find hidden scope" / "pre-plan this ticket"
- "what could this affect" / "before I start this ticket"

## Inputs

The user pastes one or more of these blocks. Only the **main requirement is required**:

| Block | Required | Notes |
|---|---|---|
| Main requirement | **yes** | The core ticket ask |
| Acceptance criteria | optional | Treated as confirmed requirements |
| Ticket comments | optional | Reviewer/product/QA notes |
| Related tickets | optional | Sibling work that may overlap |
| Related requirements | optional | Cross-ticket dependencies |
| PR link | optional | **Do NOT auto-fetch.** See PR rule below. |
| Business-rule notes | optional | Domain context |

If a block contradicts another (e.g., comment overrides AC, related ticket conflicts with main req), **mark the conflict explicitly in the output** under "Conflicts". Never silently merge.

### PR rule

If a PR link is pasted:
- **Default**: prefer the user's pasted diff/context. Do NOT prompt to fetch.
- **Fetch only on explicit instruction**: `"fetch PR"` or `"use this PR link"`.
- **When fetching**: use the host's diff command (e.g. `gh pr diff <num>` for GitHub, the equivalent for your ticket/PR host). Cap intake at ~500 lines; summarize larger hunks.

## Workflow

### Step 0: Spec present?

If the user input contains a written spec (a markdown doc, before/after code blocks, or a numbered change list), set **spec_mode = true**. In spec mode:

- The spec **is** the scope. Skip aggressive scope expansion in Step 3; use greps to verify spec items, not to overrule them.
- Step 4 (checklist) is used to flag items the spec *omits*, not to override what it says.
- Output includes a **Spec adherence** block listing every spec item with status `will-do | needs-clarification | conflicts-with-codebase`.
- `conflicts-with-codebase` requires a named code reference (file:line). "Grep was clean" does not qualify.
- See the workspace wiki's `wiki/workflows/spec-driven-cross-repo-ticket.md`.

### Step 1: Parse inputs

Bucket each pasted block: confirmed requirements, AC, comments, related-ticket influence, PR/diff influence, business-rule notes. Carry buckets through but **omit empty buckets from the final output**.

### Step 2: Extract search terms

From the parsed inputs extract: domain nouns, entity names, field names, route/endpoint names, UI labels, business-rule keywords. Dedupe. Cap at ~15 terms. Show only the final term list as a one-liner; do NOT narrate the extraction.

### Step 3: Targeted narrow search (lazy)

The only repo I/O. **Disciplined, not exhaustive.**

**Search budget:**
- **Default**: max 8 grep + 8 snippet reads
- **High-risk**: max 12 grep + 12 snippet reads (only when a high-risk signal from Step 7 fires)

**Lazy loop**: run greps in priority order (highest-confidence terms first). **Stop early** as soon as enough evidence exists to produce a useful pre-plan. Do NOT exhaust the budget. Do NOT search for every checklist category. The checklist guides risk thinking. Searches are evidence-gathering, not coverage.

**Mechanics:**
- `grep -rn -m 5 "<term>" <backend-src> <frontend-src>` (filename + line, max 5 hits per term). Resolve the source directories from the working repo (and its siblings in `os-config.yaml` when the ticket spans repos).
- For each top-3 hit per term: one snippet read via `grep -n -A 5 -B 5 -m 1`. **Snippets capped at ~40 lines.** No full `Read` of files.
- Scope: the working repo's source and test directories. **Exclude** the generated-client directory, `**/Migrations/`, `**/bin/`, `**/obj/`, `**/node_modules/`, and any other build/vendored output.

**Pipeline traversal (one level deep, counts against snippet budget):** When a search hit lands inside a handler, snippet-read it for downstream dispatch calls (mediator/command dispatch, message-bus enqueue, job scheduling). For each dispatched/enqueued command found, spend one snippet read on that downstream handler. These adjacent handlers never appear in ticket text and are only reachable by following the dispatch chain.

**In each downstream handler reached by traversal, look for:**
- Nullable field filters (`.Where(x => x.Field != null)`, `.HasValue`) on fields that are null for the new variant the ticket introduces: handler runs but processes zero records, no error
- Iteration of collections that don't exist for the new variant (e.g. a handler loops over `<entity>.<subCollection>` that a newly introduced variant never populates): same silent-zero outcome
- Missing eager-load / `.Include()` for navigation properties the handler reads: returns null silently instead of throwing

**When the ticket adds or changes an operation on an existing entity:** also spend one snippet read on the entity's flag/enum extension methods (pattern: `static bool [Verb](this [EnumType])`). These are routing gates for all downstream scheduling. A missing flag = downstream job silently never enqueues.

### Step 4: Apply the checklist (internal, no additional repo I/O)

Applied using only what Step 3 already found. For each item tag ✅ covered / ⚠️ likely-affected / ❌ not relevant. **Only ⚠️ items appear in the output** under "Likely missed areas".

**Checklist:**

1. Validators (validation layer / request validators)
2. API contract (endpoint modules, request/response DTOs)
3. Generated client (does the client need regeneration?)
4. Frontend schemas/types (validation schemas, generated types)
5. UI forms (form components, error rendering)
6. Imports/exports (file/CSV parser, template files, downloads)
7. Calculations / business rules (domain handlers / logic)
8. Cloning / copy paths (clone/duplicate helpers)
9. DTOs / mappers (handoff, cross-repo integration)
10. Tests (existing test class for the symbol: does it cover the change?)
11. Background jobs (schedulers; idempotency; if a job chain has a terminal cleanup/state-reset continuation, every intermediate continuation must run on any finished state, not only on success. A success-only continuation silently skips the terminal step on failure, leaving state flags permanently stuck)
12. Authorization (resource authorization, attribute/policy selection)
13. Serialization / nullability / default behavior
14. Existing records & migration / default impact (backfill, defaulting)
15. Reports / downloads / exports
16. Cache / background data freshness (cache reads, eviction)
17. Feature flags / config switches
18. Error handling / user feedback (result shape, message rendering)
19. Manual-test / QA impact (what changes for the testing guide?)
20. Duplication: will this add a literal/expression/guard that already exists (or will exist) in ≥2 files? Plan the shared constant / extension / helper now (backend **and** frontend); collapse a guard repeated N× into one predicate. If a copy is unavoidable because the query engine can't translate a helper inside a query, plan a drift test pinning the copy to the helper. _(See the repo's known-issues on repeated PR mistakes, if it carries one.)_
21. Cross-repo data dependency: does any new filter/behavior need a field the backend endpoint doesn't currently return, or data only another repo owns? If yes → flag a paired ticket in the owning repo, and bound filter option-sets to what the source data actually supports (don't offer choices that yield zero results). _(See the repo's known-issues on cross-repo scope misses, if it carries one.)_

### Step 5: [repo-local-OS only] Categorize and route

Skip this step unless the working repo is listed under `repo_local_os` in `os-config.yaml` and its `rules_dir` exists at the repo root. Resolve the `rules_dir` path from that entry. Everything below is expressed relative to it.

Pick **one** primary category, the dominant one. If multiple qualify, do **not** record a secondary; instead bump the risk level in Step 7.

| Category | Trigger signals |
|---|---|
| `backend-slice` | new handler/spec/validator, no frontend impact |
| `api-contract-change` | backend DTO/endpoint change that regenerates the client |
| `frontend-feature` | UI / form / data-fetching change with no backend contract change |
| `core-domain-logic` | touches the repo's business-critical calculation/workflow area (resolve which area from the repo's known-issues) |
| `integration` | cross-service fetches, caching paths, external-source reads |
| `regression-risk-heavy` | broad multi-feature touch OR ≥2 of the above qualify |

Routing matrix (roles only, do not inline rule-doc content; the exact filenames live in the repo's `rules_dir`, organized by convention into `workflows/`, `standards/`, `known-issues/`):

| Category | Rule docs to load (in order, by role) | Follow-up skills |
|---|---|---|
| backend-slice | `workflows/` doc for a backend slice, `standards/` backend doc, `workflows/` pre-PR risk check | `/cross-repo-review` _(if invariant-heavy)_, the repo's code-review + unit-test + manual-test skills |
| api-contract-change | `workflows/` doc for a contract change, `standards/` backend + frontend docs, `workflows/` pre-PR risk check | code-review + unit-test skills, `/cross-repo-manual-test` _(developer + QA hand-off)_ |
| frontend-feature | `standards/` frontend doc, `workflows/` pre-PR risk check | code-review skill, manual-test _(QA hand-off)_ |
| core-domain-logic | `known-issues/` doc for the business-critical area, `standards/` backend doc, `workflows/` pre-PR risk check | unit-test + code-review skills, `/cross-repo-manual-test` _(business-critical hand-off)_ |
| integration | `standards/` backend doc, `workflows/` pre-PR risk check | unit-test + code-review skills |
| regression-risk-heavy | matched-category docs + every relevant `known-issues/` doc | unit-test + code-review skills, manual-test (developer + QA hand-off) |

Always append the repo's repeated-PR-mistakes known-issues doc (if it has one) to the load list. Never load the whole rules directory.

**Manual-test mode hint:** developer mode for backend/contract validation, QA hand-off mode for business validation. Emit both for full-stack tickets.

### Step 6: Cross-repo check (invariant-driven mini-spec)

Trigger on any of: cross-repo touch, handoff DTO, precision / serialization / persistence / data-flow change, migration, schema change, integration boundary, or ticket text mentioning another repo in `os-config.yaml` (`repos` / the backend of record / a shared-lib / a migrations repo).

When triggered, the output **must** include the **Cross-repo mini-spec** block from the Output template, with these sections, in this order: `## Invariant`, `## System touch map`, `## Evidence used`, `## What changes`, `## What not to change`, `## Open questions`. These supplement (they do not replace) `Affected surfaces`, `Edge cases`, `Tests to add or update`, and `Implementation Handoff`.

Rules when emitting the mini-spec:

- **Invariant is mandatory.** One or two sentences naming the end-to-end property that must hold (precision preserved across the wire, idempotency on a stated key, identity stable across days, etc.). If you can't state it, stop and ask. You don't have a spec yet.
- **Out-of-scope requires positive evidence.** Every line in `## What not to change` cites a named artifact (file:line, DB row, captured payload, log line) showing the invariant holds without changing that surface. "Verified clean" / "grep was empty" / "no hits" are banned.
- **Negative grep is not enough.** A surface that grep didn't hit is not `not-touched`. If you cannot positively rule it out, it is `unknown` and goes into both `## System touch map` (as `unknown`) and `## Open questions`.
- **Evidence ranking.** Specs, DB rows, stored JSON, logs, and captured payloads **outrank** code search. Code outranks docs. Negative grep results are never conclusive. Cite the highest-rank evidence available in `## Evidence used`.
- **Touch map covers every surface in the topology.** Enumerate every repo in `os-config.yaml` `repos` plus every seam in `seams` (especially the message bus), each tagged `touched | not-touched | unknown` with a one-line reason.
- **Tests validate the invariant.** Each entry in `## Tests to add or update` names the invariant it asserts (round-trip exact value, idempotency on the stated key, identity-across-days, etc.). No tolerant assertions for precision / serialization invariants.
- **Active artifact prompt.** Before finalizing the mini-spec, ask the user once whether they can paste any of: a DB column / schema row, stored JSON, a captured request/response payload, a relevant log line, a generated-client method or type signature, or a migration filename / migration tail. Name only the two or three most relevant to this ticket. Do not list all six. Do not block: if the user provides nothing, continue normally. Do not fetch production data. The purpose is to improve invariant quality, not gate progress.
- **Invariant self-check against pasted artifacts.** Before emitting the mini-spec, scan the current conversation for any pasted schema row, DB column definition, stored JSON, captured wire payload, or log line. If an artifact contradicts the stated invariant (e.g., DTO assumes `decimal(18,2)` but pasted column is `decimal(18,4)`; payload field is null but invariant assumes non-null; date is `DateTime` but stored as `DateOnly`), surface it as a `Conflicts` entry or an `Open questions` entry. Never silently merge. Do not fetch production data; artifacts must already be in the conversation. If no artifact is present, proceed normally.
- **Risk level auto-bumps to ≥ Medium.**
- **Offer durable invariant storage (optional, cross-repo/high-risk only).** After emitting the mini-spec, ask the user once whether to save a small per-feature invariant file at `wiki/features/<ticket>-<short-name>.md` in the workspace wiki. Do not auto-write. Only write on explicit "yes", and only when running from the workspace root (where `os-config.yaml` and the wiki live). Never offer this for normal (non-cross-repo) tickets. File contents are limited to: ticket id / short name, the invariant, the system touch map, the evidence used, the open questions, date created, last reviewed date. No diff content, no implementation notes, no narrative recap. Keep the file tiny.

Load (paths only, do not inline content). Pick whichever set exists for the current workspace; do not hard-fail if a set is missing; if both exist, load both:

- When running from the workspace root (where `os-config.yaml` and the wiki live):
  - `wiki/system-map.md`
  - `wiki/workflows/spec-driven-cross-repo-ticket.md`
- When running from inside a repo that carries a repo-local rules directory, load if present:
  - `<rules_dir>/system-map.md`
  - `<rules_dir>/workflows/spec-driven-cross-repo-ticket.md`

### Step 7: Score risk and emit

**Risk signals** (any one fires the high-risk budget): DB/schema change, API contract change, generated client impact, business-rule/calculation change, import/export change, validation change, background job impact, broad frontend/backend change, multi-domain touch, unclear requirements.

**[repo-local-OS only] Risk level**, explicit mapping for the routing block:
- **Low**: no risk signal fired, single surface, contained.
- **Medium**: 1 signal fired OR ≥2 surfaces.
- **High**: ≥2 signals OR generated-client impact `likely` OR the repo's business-critical area touched OR ≥2 categories would have qualified.

**[repo-local-OS only] Generated-client impact**, explicit tag for the routing block:
- **unlikely**: frontend-only, or backend with no DTO/endpoint change.
- **possible**: backend touches DTO/handler but ambiguous.
- **likely**: confirmed DTO/endpoint signature change.

**[repo-local-OS only] Regression hotspots**, max **2**, picked from the repo's own known-issues catalog only (resolve from the `known-issues/` docs in its `rules_dir`). Or "none".

**Confidence tagging on every affected surface:**
- **confirmed**: exact symbol/string match in code
- **likely**: adjacent-pattern match or strong domain-noun overlap
- **possible**: checklist suggests it but no grep hit. *"No grep hits" ≠ "safe."*

**Output hard limits:**
- max 8 affected surfaces
- max 10 edge cases
- max 12 likely-missed checklist items (⚠️ only)
- max 5 open questions
- no generic advice
- no full file dumps
- no large tables

## Output template

```markdown
# Ticket Impact Pre-Plan

**Ticket goal**: <one sentence, derived from main requirement>

**Risk flags**: <comma-separated list of fired signals, or "none">

## Repo-local rules routing
_Emitted only when the working repo is listed under `repo_local_os` and its `rules_dir` exists. Paths only. Never inline rule-doc content._

- **Category**: <one primary>
- **Risk level**: Low | Medium | High
- **Generated client impact**: unlikely | possible | likely
- **Regression hotspots**: <up to 2, or "none">
- **Load context (in order)**:
  - `<rules_dir>/<path>`
  - ...
- **Follow-up skills**: /skill-a, /skill-b
- **Targeted exploration** (max 3: one handler/slice, one frontend area, one similar example):
  - <handler/slice hint>
  - <frontend area hint>
  - <similar implementation/example hint>

## Cross-repo mini-spec
_Emitted only when Step 6 triggered. Omit entirely otherwise._

### Invariant
<one or two sentences: the end-to-end property that must hold>

### System touch map
| Surface | Status | Reason |
|---|---|---|
| <repo from os-config.yaml> | touched / not-touched / unknown | <one line> |
| <repo from os-config.yaml> | touched / not-touched / unknown | <one line> |
| <shared-lib repo> | touched / not-touched / unknown | <one line> |
| <migrations repo> | touched / not-touched / unknown | <one line> |
| <message bus / seam from os-config.yaml> | touched / not-touched / unknown | <one line> |

### Evidence used
- <highest-rank artifact for current behaviour: DB row / captured payload / log line / file:line>
- ...

### What changes
- <surface, file:line, one-line change>
- ...

### What not to change
- <surface>: invariant holds because <named artifact: file:line / payload / DB row>
- ...

### Open questions
- <every `unknown` row from the touch map, plus anything the spec doesn't pin down>
- ...

## Inputs received
<list only the buckets that have content: main req / AC / comments / related / PR / business notes>

## Conflicts
<only if conflicts exist between buckets; otherwise omit this section>

## Search terms used
<comma-separated, max 15>

## Affected surfaces (max 8)
- **<file or area>**: <one line> (_confidence: confirmed / likely / possible_)
- ...

## Likely missed areas (⚠️ only, max 12)
- <checklist item>: <one-line why it likely applies here>
- ...

## Edge cases (max 10)
- <case>
- ...

## Tests to add or update
- <test class or scenario>: <one-line reason>
- ...

## Non-goals
- <what this ticket explicitly does NOT cover>

## Assumptions
- <each assumption I'm making, so the user can correct>

## Open questions for PM/product (max 5)
- <only when genuinely useful>

## Implementation Handoff
(Compact-but-complete. A cheaper implementation model should be able to execute the confirmed plan from this section alone, without the full planning conversation.)

- **Goal**: <ticket goal>
- **Affected files/areas**: <bullet list, paths only>
- **Required changes**: <bullet list, one line each>
- **Validation/schema/API impacts**: <bullet list>
- **Edge cases to handle**: <bullet list>
- **Tests required**: <bullet list>
- **Non-goals**: <bullet list>
- **Assumptions**: <bullet list>

---
**Deep pass recommended**: yes/no, <one-sentence reason>
```

## Hard rules

- **Single purpose.** Stop after emitting the output. Do NOT invoke superpowers:writing-plans, do NOT save to a file, do NOT start implementation.
- **No broad scans.** No `find -name` sweeps, no `grep -r` without a specific term, no full `Read` of files.
- **Cost discipline.** Default 8+8. Burn the high-risk 12+12 budget only when a risk signal has fired.
- **Lazy stopping.** Stop searching as soon as the pre-plan is supportable. Do not seek coverage of every checklist category.
- **No grep hits ≠ safe.** Surfaces the checklist suggests but greps didn't confirm go in as `possible`.
- **Conflicts are explicit.** If buckets disagree, render a Conflicts section. Never silently merge.
- **Empty buckets are omitted.** Don't render headings for sections with no content (except Implementation Handoff, which is always present).
- **Output is the only artifact.** No file writes unless the user explicitly says "save it to <path>".
- **Repo-local rules routing references paths only.** Never inline or summarize a rule doc into the routing block. The user opens the listed file when they need its content. Never invent rule-doc paths, only ones that actually exist under the repo's `rules_dir`.
- **Evidence ranking** (governs every inclusion/exclusion): production data / stored artifacts > exact code match > grep hit > absence of grep hit. The last tier never justifies excluding a surface.
- **Non-goals must cite evidence.** Each `Non-goals` line names the artifact or code reference that verified the exclusion, or is tagged `unverified-exclusion` and moved to `Open questions` instead. "Verified clean" without a named artifact is banned.
- **Spec is contract.** In spec_mode, a deviation from the spec requires a named code reference, not a negative grep.

## Anti-patterns

| Don't | Do |
|---|---|
| "I checked everything, looks fine" | List checklist ⚠️ items with reasoning |
| Read the full handler file | Snippet-grep ±5 lines around the match |
| Auto-fetch every PR link | Wait for "fetch PR" |
| Run all 8 greps even after pre-plan is supportable | Stop early |
| Output empty buckets ("Comments: (none)") | Omit them |
| Invent edge cases unrelated to the ticket | Keep edge cases to what the inputs + checklist actually flag |
| Append "I'll now write the plan" | Stop after the output |
| Stop at the first handler hit, never follow dispatch chain | Pipeline traversal (Step 3): follow the dispatch/enqueue chain one level deep |
| Do additional reads during checklist (Step 4) | Step 4 is internal only. All I/O happens in Step 3 including traversal |

## Example trigger

> User: `/ticket-impact`
> PROJ-1234: add new order-line columns (PrevDiscount, VendorName, SkuName, SkuId, ListPrice). AC: users can upload a CSV with these new columns; values persist on `OrderLine.Skus` and `PrevDiscount`.

Skill produces (compact form):

> **Risk flags**: validation change, import/export change, generated client impact
> **Search terms**: PrevDiscount, VendorName, Skus, RawOrderRecord, OrderLineValidator, ...
> **Affected surfaces**: `OrderLineValidator.cs` (likely, needs rules for new fields), `OrderCsvParser.cs` (confirmed), `OrderLine.cs` (confirmed), `OrderCloneExtensions.cs` (possible, verify field copy), ...
> **Likely missed**: validators (new fields lack rules); cloning path (verify copy); generated client (regen the client); manual-test (template-mismatch flow); ...
> **Repo-local rules routing**:
> - Category: api-contract-change
> - Risk level: High
> - Generated client impact: likely
> - Regression hotspots: order-import eager-load, schema nullable parsing
> - Load context: `<rules_dir>/workflows/api-contract-change.md`, `<rules_dir>/standards/backend.md`, `<rules_dir>/standards/frontend.md`, `<rules_dir>/known-issues/repeated-pr-mistakes.md`
> - Follow-up skills: unit-test + code-review skills, /cross-repo-manual-test (developer + QA hand-off)
> - Targeted exploration:
>   - Features/Orders/Validators/OrderLineValidator.cs (handler/slice)
>   - web/src/features/orders/ (frontend area)
>   - similar slice: Features/Orders/ existing upload path
> **Implementation Handoff**: ... (compact handoff block)
> **Deep pass recommended**: no, scope is contained to the order-import path.
