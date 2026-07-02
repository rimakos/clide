---
name: cross-repo-manual-test
description: Use when producing a manual test guide for a cross-repo, handoff, precision, serialization, persistence, or data-flow change, especially when `/ticket-impact` produced a Cross-repo mini-spec. Builds an invariant-anchored test plan with developer and QA/business modes, production artifact checks where relevant, and explicit "must stay unchanged" assertions. Does NOT replace the normal `/manual-test`; invoke explicitly with `/cross-repo-manual-test`.
---

# cross-repo-manual-test

## Purpose

Produce a manual test guide whose pass/fail conditions are tied directly to the stated invariant, not to implementation steps. Complements (does not replace) the normal `/manual-test`. Invoked explicitly, typically after `/ticket-impact` emitted a Cross-repo mini-spec.

## When to use

Invoke `/cross-repo-manual-test` when the change's correctness depends on an end-to-end property that crosses repos, wire boundaries, storage, or time. Use the normal `/manual-test` for single-repo UI tweaks, isolated bug fixes, or anything without a cross-cutting invariant.

## Inputs

- The Cross-repo mini-spec from `/ticket-impact` (`## Invariant`, `## System touch map`, `## Evidence used`, `## What changes`, `## What not to change`, `## Open questions`).
- If running from the workspace root (where `os-config.yaml` and the wiki live): `wiki/system-map.md`, `wiki/workflows/spec-driven-cross-repo-ticket.md`.
- If running from a repo that carries a repo-local rules directory (a repo listed under `repo_local_os` in `os-config.yaml`): `<rules_dir>/system-map.md`, `<rules_dir>/workflows/spec-driven-cross-repo-ticket.md` if present.

Load whichever sets exist. Do not hard-fail if missing. If no mini-spec, ask the user for the invariant in one sentence before drafting the guide. Do not infer it from the diff.

## Modes

If the user says `dev`, emit developer validation only. If the user says `qa`, emit QA/business validation only. If unstated, emit both blocks.

- **dev**: developer validation. May include API calls, log lines, DB row inspection, generated-client checks, deploy-order checks.
- **qa**: QA / business validation. UI-driven flows only. No SQL, no log inspection, no API tooling. If a check truly cannot be expressed in the UI, mark it `dev-only` and move it to the dev block.

## Workflow

1. Pull the invariant verbatim from the mini-spec (or from the user). State it at the top of the guide.
2. From `## System touch map`, list the surfaces that participate in the test flow (`touched` and `unknown`). Skip `not-touched` rows in the test steps, but list them under "Must stay unchanged".
3. Identify the production-style artifact that proves the invariant: the persisted DB value, the captured wire payload, the rendered PDF/CSV cell, the log line, the generated-client response shape. Each pass/fail check resolves against one of these, not against "the UI looks right".
4. Build the dev block: setup, walkthrough, pass/fail check per invariant facet, artifact to capture.
5. Build the qa block: same flow, UI-only. Pass/fail in business terms ("the total on screen and on the downloaded PDF match the value the user entered").
6. List "Must stay unchanged" surfaces with the specific user-visible behaviour that should be identical to before the change.

## Output template

```markdown
# Manual test — <ticket / short title>

**Invariant**: <one sentence — verbatim from the mini-spec or the user>

**Affected surfaces**:
- <surface — one-line role in this flow>
- ...

**Production artifacts to check**:
- <DB row / wire payload / rendered document / log line / generated-client response>
- ...

## Setup
- <env, user/role, feature flag, seed data — concise>

## Developer validation (dev mode)
1. <step — concrete action>
   - **Pass**: <invariant facet observed, e.g. "stored decimal scale == 4 and equals input">
   - **Fail**: <what would refute the invariant>
   - **Capture**: <artifact: payload, row, log line>
2. ...

## QA / business validation (qa mode)
1. <step — UI action in business terms>
   - **Pass**: <user-visible outcome that proves the invariant>
   - **Fail**: <user-visible outcome that would refute it>
2. ...

## Must stay unchanged
- <surface / screen / report> — <specific behaviour identical to before>
- ...

## Open questions
- <every `unknown` row from the touch map that this test would resolve>
```

Omit empty sections. If `qa` mode has no UI-expressible checks, say so explicitly and route the test to dev mode only.

## Hard rules

- **Invariant first.** No test guide without a stated invariant. If the user can't state it and no mini-spec exists, stop and ask.
- **Pass/fail ties to the invariant.** Every check resolves the invariant or a named facet of it. Do not include checks that only verify implementation details.
- **No SQL or code-level steps in qa mode.** UI-only. Anything that needs DB/log/API access moves to dev mode and is labelled `dev-only`.
- **Production artifacts outrank screen state.** When the invariant is precision/serialization/persistence, the canonical check is the stored or captured value, not what the UI renders.
- **"Must stay unchanged" is mandatory.** Every `not-touched` surface from the mini-spec that the user could plausibly look at gets one line here. Negative grep does not earn a surface a place on this list. Only positive evidence does.
- **No file edits.** This skill emits the test guide as output. It does not write `.md` files unless the user explicitly says "save it to <path>".
- **No git actions.** Never stage, commit, push, branch, or amend.
- **Concise.** One to three lines per step. No narrative recaps.
- **Does not replace `/manual-test`.** Additive. Recommend `/manual-test` for the general developer/QA checklist if the user hasn't run it.
