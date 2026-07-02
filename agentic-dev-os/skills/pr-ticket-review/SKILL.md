---
name: pr-ticket-review
description: Ticket-aware layer over a PR: does the PR actually satisfy its ticket, and does it create any cross-repo ripple. Reads the ticket (requirements + decisions-in-comments) from your ticket source (Jira / Linear / GitHub / Azure DevOps / ...), maps each to the diff (satisfied/partial/missing), and flags cross-repo/contract gaps. Delegates code-defect/convention/duplication review to your code-review skill (does NOT re-implement it). Triggers on /pr-ticket-review, "does this PR meet the ticket", "review this PR against the ticket", "requirements check this PR", "ticket coverage for PR <id>". Read-only, never edits, posts, or commits.
---

# pr-ticket-review

## Purpose

Answer the one question a code-defect reviewer never asks: **does this PR do what the ticket asked, and does it ripple across repos?** It is a thin requirements + cross-repo layer, not a second code reviewer. For logic/convention/duplication defects it hands off to your code-review skill (the built-in `/review` or a repo-local equivalent).

## When to use

- `/pr-ticket-review` slash command
- "does this PR meet the ticket" / "review this PR against the ticket"
- "requirements check this PR" / "ticket coverage for PR \<id\>"

Pairs with (does not replace):
- **Your code-review skill** → code defects, backend/frontend conventions, duplication, posts inline PR comments. Run it for code quality.
- **`/cross-repo-review`** → invariant/precision/serialization correctness. Recommend it when the diff is invariant-heavy.

## Inputs

**Required**:
- PR id (or branch). The ticket id is auto-derived per your ticket source's convention (resolve `ticket_source` and `ticket_prefix` from `os-config.yaml`, e.g. a PR title prefix or branch name that encodes the ticket id). If none derivable, ask.

**Optional**:
- Pasted ticket text and/or diff (skips fetch).

## Why this shape (rationale)

Layer team-specific concerns on top of a baseline, don't duplicate it; precision over recall; targeted intake over broad scans. The code-defect reviewer already owns the code-quality baseline, so this skill adds only the missing layer (requirements traceability + cross-repo), and reuses the existing PR-fetch plumbing rather than forking it.

## Workflow

### Step 1: Resolve ticket + PR (reuse existing plumbing)
- Derive the ticket id per your source's convention. Fetch the ticket from your ticket source (the MCP/CLI/API for `ticket_source` in `os-config.yaml`). Extract: core requirement, acceptance criteria, and **decisions already made in comments** (often contain caught bugs/regressions; they count as requirements and override the description).
- Fetch PR metadata from your PR host (its MCP, CLI, or API): title/description/source + target branch. **If the preferred integration is not connected, fall back to the host's CLI, don't stall.** Prefer the MCP when present.

### Step 2: Get the diff (capped, name-list first)
- Skip if a diff was pasted.
- **Read by SHA, never the working tree.** `git fetch origin <sourceSha> <targetSha>` first, then `git diff <targetSha>...<sourceSha>` and `git show <sourceSha>:<path>`. The local checked-out branch is irrelevant: no checkout/switch/stash needed, and it keeps the review read-only. **Never `cat`/Read a repo file for PR content**: that reads whatever branch is checked out (usually the default branch) and yields stale text masquerading as the PR. Working-tree reads are only valid for files not in the diff.
- `git diff <targetSha>...<sourceSha> --name-only` with generated/vendored exclusions (`*/Migrations/*`, `*.Designer.cs`, the generated-client directory, other codegen output) for the changed-file list.
- Pull the diff only for files relevant to a requirement. Cap intake to changed lines; summarize hunks over ~150 lines. No full-file reads, no broad scans.

### Step 3: Requirements pass (the core output)
Map **each requirement / AC / decision-in-comments** → `satisfied | partial | missing`, each cited to a diff hunk (`file:line`) or named as absent. This is what a code-defect reviewer cannot do: it never sees the ticket.
- `partial` = the surface is touched but an AC sub-point or edge case is unhandled.
- `missing` = no diff evidence the requirement was addressed. A missing requirement is a **blocking** finding.

### Step 3b: Verify before reporting (both-sides trace)
Every `partial` and `missing` must survive a static verification gate: no execution, no edits, just trace. Drop or downgrade any finding that can't pass:
- **Broken side**: cite the exact line that's wrong/absent (`file:line`).
- **Working side**: cite the sibling/precedent it deviates from: the existing code that does the same job correctly (`file:line`). A finding with no provable deviation is a **suspected** finding, not a confirmed one. Say so or drop it.
- **Failing-check spec**: state the one test that fails now and would pass once fixed (inputs → expected vs current). This makes the fix verifiable downstream: the skill does NOT write or run it. Example: "`getData` with `record.storedUrl` set and no fresh data → expect stored URL; currently returns undefined."

Confirmed = broken side + working side both cited. No working-side counterpart → mark `suspected` and lower confidence.

### Step 4: Cross-repo ripple (pointer only)
Flag, don't deep-dive (cite the seam from `wiki/system-map.md` if loaded, or `os-config.yaml` `seams`):
- Filter/option-set not bounded by the owning repo's source data → needs a **paired ticket**.
- Changed DTO/contract or message-bus payload crossing a seam → name the listener side that must move in lockstep.
- Backend signature change → generated client regen needed in the same PR.
- A requirement that depends on a field the backend endpoint doesn't return → paired ticket in the owning repo.

### Step 5: Emit + hand off
Output the template. Then, in one line each:
- Recommend **your code-review skill** for the code-defect/convention/duplication pass. This skill deliberately skipped it.
- Recommend **`/cross-repo-review`** if any Step 4 flag is invariant/precision/serialization-shaped.
Stop. Do not invoke them.

## Output template

```markdown
# Ticket coverage: PR <id> (<ticket-id>)

**Ticket**: <one-line ask>  **Verdict**: <meets ticket / gaps / does-not-meet>

## Requirements
| Requirement / AC / decision | Status | Evidence |
|---|---|---|
| <item> | satisfied / partial / missing | file:line or "absent" |

## Gaps (blocking)
- <missing/partial requirement>: <what's not addressed>
  - Broken: <file:line> · Deviates from: <file:line working sibling> · Confidence: confirmed / suspected
  - Failing check: <inputs → expected vs current> (not run, for the fix to satisfy)

## Cross-repo flags
- <surface>, <seam>, <paired-ticket / contract / regen>

## Next
- Code quality: run your code-review skill.
- [if invariant-heavy] Correctness: run `/cross-repo-review`.
```

Omit empty sections. Full coverage, no ripple → Requirements table + "Meets the ticket. Run your code-review skill for code quality."

## Proposed PR comments (chat-only, NEVER posted)

After the coverage report, for every gap/finding that is worth raising on the PR, also render it as a ready-to-paste inline comment, so the user can copy it into the PR host themselves. **Output here only. Never post to the PR** (see Hard rules).

Match how comments are actually written on your team's PRs: short, plain, conversational. Not the report's `Broken/Deviates/Failing-check` scaffolding (that stays in the Gaps section above); the comment is the human version.

Voice rules:
- 1–3 sentences. State the concern, then propose the change **as a question** ("Should we…?", "Can we…?", "…, right?"). Collegial, not a verdict.
- No bold `Bug —` / severity headers, no emoji, no `Confidence:` line inside the comment.
- Concrete one-to-few-line code change → use a ` ```suggestion ` block if your PR host renders it as an applyable suggestion.
- Anchor each one with a `file:line` line above it so the user knows where it goes.
- One comment per finding. Keep cross-repo/regen notes as a trailing "heads up" sentence, not a section.

Format:

```markdown
## Proposed comments (copy-paste, not posted)

`web/.../SomeComponent.tsx:84`
<one-to-three sentence comment in house voice, question-form if proposing a change>
```

Example (a persisted-value gap, house voice):

> `web/src/pages/detail/DetailView.tsx:84`
> `getData` only reads the fresh response, so after a reload the value falls back to "not generated yet" while the sibling field still renders from stored data. Should we give it the same persisted fallback the sibling has, e.g. `hasValue(record?.storedUrl)`? Heads up the client needs a regen first. The DTO didn't pick up that field.

## Hard rules

- **Stay in your lane.** Requirements + cross-repo only. Do **not** re-review logic, conventions, duplication, naming, dead code. That's the code-review skill's job. If you spot a code defect in passing, note it in one line under a `Noticed (for code-review)` bullet, don't expand it.
- **Read-only. NEVER post to the PR.** No file edits, no posting to PR threads, no git actions, even if a follow-up skill or menu option says it posts. Render comments in chat (see "Proposed PR comments") for the user to paste. Post only if the user explicitly says "post" in that turn. (Picking a follow-up skill from a menu is NOT post approval.)
- **Prefer the connected integration; fall back to the CLI.** Use your PR host's MCP when present; fall back to its CLI only when the MCP is not connected. Never stall on a missing integration.
- **Decisions-in-comments are requirements.** Always read the ticket's comments, not just its description.
- **Capped intake.** Name-list first, then only requirement-relevant hunks. No broad scans.
- **A missing requirement is blocking.** Negative evidence ("no hunk addresses it") is a valid `missing`, not an unverified pass, but say which requirement and where you looked.
- **Verify both sides before reporting (read-only).** Each gap = broken-side line + working-side sibling it deviates from + a failing-check spec. No working-side counterpart → mark `suspected`, don't assert. Never write or run the check, never apply the fix, emitting the verifiable spec is the deliverable; implementation is a separate pass.
- **No auto-chain.** Recommend the follow-up skills; don't invoke them.

## Anti-patterns

| Don't | Do |
|---|---|
| Re-implement the code-review skill's convention/dup checklist | Map requirements; hand code quality to the code-review skill |
| Stall when the preferred MCP is absent | Prefer the MCP; fall back to the host CLI |
| Review the description only | Read decisions-in-comments as requirements |
| Read whole files / scan repos | Name-list, then requirement-relevant hunks only |
| `cat`/Read repo files for PR content | `git show <sourceSha>:path` (working tree is the wrong branch) |
| Deep-dive a cross-repo flag | One-line pointer + paired-ticket call |
| Expand a passing code observation | One `Noticed (for code-review)` line, move on |
| Assert a gap with no working-side proof | Trace broken + sibling; else mark `suspected` |
| Write/run the check or apply the fix | Emit the failing-check spec; leave impl to another pass |
| Post to the PR | Output in chat; user posts manually |
