---
name: cross-repo-review
description: Use when reviewing a diff or PR for a cross-repo, handoff, precision, serialization, persistence, or data-flow change, especially when `/ticket-impact` produced a Cross-repo mini-spec. Invariant-aware review: checks the diff against the stated invariant, the system touch map, evidence for out-of-scope surfaces, and that tests assert the invariant rather than implementation details. Does NOT replace the built-in `/review`; invoke explicitly with `/cross-repo-review`.
---

# cross-repo-review

## Purpose

Invariant-aware review pass for diffs whose correctness depends on an end-to-end property that crosses repos, wire boundaries, storage, or time. Complements (does not replace) the built-in `/review`. Invoked explicitly, typically after `/ticket-impact` emitted a Cross-repo mini-spec.

## When to use

Invoke explicitly via `/cross-repo-review` when the change touches any of: cross-repo handoff, DTO / contract on a wire boundary, precision / serialization, persistence, data-flow across repos, migration with backfill or default semantics, generated-client regeneration, message-bus payload, or any diff for which a Cross-repo mini-spec exists.

Do **not** use for: single-repo UI tweaks, isolated bug fixes with no contract change, style/format-only diffs. Use built-in `/review` for those.

## Inputs

- The diff (current branch, staged + unstaged, or a pasted patch).
- If present: the Cross-repo mini-spec from `/ticket-impact` (`## Invariant`, `## System touch map`, `## Evidence used`, `## What changes`, `## What not to change`, `## Open questions`).
- If running from the workspace root (where `os-config.yaml` and the wiki live): `wiki/system-map.md`, `wiki/workflows/spec-driven-cross-repo-ticket.md`.
- If running from a repo that carries a repo-local rules directory (a repo listed under `repo_local_os` in `os-config.yaml`): `<rules_dir>/system-map.md`, `<rules_dir>/workflows/spec-driven-cross-repo-ticket.md` if present.

Load whichever sets exist. Do not hard-fail if missing. If no mini-spec was provided, ask the user for the invariant in one sentence before reviewing. Do not infer it from the diff alone.

## Review checks

For each check, emit a finding only when something is wrong, missing, or unverified. Silence = pass.

1. **Invariant preservation.** Does the diff, end-to-end, preserve the stated invariant? Trace the value/identity/idempotency key through every layer the diff touches. Name the file:line where the invariant could break.
2. **Touch-map completeness.** Every surface in the mini-spec's System touch map must be accounted for by the diff. Flag any `touched` surface absent from the diff, any diff hunk in a surface marked `not-touched`, and every `unknown` row that the diff does not resolve.
3. **Out-of-scope evidence.** For each row in `## What not to change`, confirm the cited artifact (file:line, DB row, captured payload, log line) actually supports the claim. Reject "verified clean", "no grep hits", or any negative-grep justification. If the diff drifts into a surface listed here without updating the mini-spec, flag it.
4. **Tests validate the invariant, not the implementation.** At least one test must name the invariant (round-trip exact value, idempotency on the stated key, identity-across-days, etc.). Flag tolerant assertions (`Approximately`, `~=`, large epsilon) for precision/serialization invariants. Flag tests that mock the contract field itself.
5. **Generated clients.** If a backend DTO/endpoint changed, the matching generated client must be regenerated and committed in the same diff. Flag a backend signature change without a client diff. (Resolve which seam owns the generated client from `os-config.yaml` `seams`.)
6. **Migrations, existing rows, deploy order.** For any schema change on an existing table, every one of the following must be addressed in the diff or its PR description (missing handling is a finding):
   - **Migration file present.** The migrations repo (per `os-config.yaml`) carries a migration matching the team's naming convention, idempotent, targeting the right database.
   - **Existing rows.** Non-nullable column additions name a default or a backfill plan. Nullability flips (NULL → NOT NULL) name how existing NULLs become valid. Type narrowings (e.g., `decimal(18,4) → decimal(18,2)`) name the truncation/rounding policy.
   - **Deploy order.** Code paths that read the new column or assume the new shape must not ship before the migration runs. Message-bus producers of a changed payload deploy after every consumer can decode the new shape. Generated-client consumers update in lockstep with the backend.
   - Flag any of the above absent, ambiguous, or contradicted by the diff.
7. **DTO contracts.** Wire shape (field names, nullability, types, decimal scale, date format) must match on both sides of every contract boundary the diff crosses. Flag asymmetric renames, nullability flips, enum-to-string changes, `DateOnly`/`DateTime` mismatches.
8. **Display vs storage precision.** Display/PDF/UI/document rounding must be applied at the render layer only. Business logic and persistence keep full precision. Flag rounding applied before storage, before serialization across a wire, or before a calculation that feeds another field.
9. **Message-bus payloads.** If a topic payload shape changed, every listener (across repos) must be updated in the same change or behind a compatible version. Flag silent payload changes. (Enumerate listeners from the relevant seam in `os-config.yaml`.)
10. **Evidence ranking honored.** Every finding cites the highest-rank evidence available: specs, DB rows, stored JSON, logs, captured payloads, then code at file:line. Negative grep alone is never a finding's evidence.

## Output format

Findings only. Group by severity. Be concise, one to three lines per finding.

```markdown
# Cross-repo review

**Invariant**: <one sentence — from the mini-spec, or supplied by user>

## Blocking
- <finding> — <file:line or artifact> — <one-line why the invariant is at risk>

## Should-fix
- <finding> — <file:line> — <one-line reason>

## Unverified (resolve before merge)
- <surface or claim> — <what evidence is missing>

## Touch-map status
- <surface> — touched / not-touched / unknown — <one-line confirmation or gap>
```

Omit any empty section. If the diff passes every check, emit only `**Invariant**: …` and a one-line "No blocking, should-fix, or unverified findings."

## Hard rules

- **Findings only.** No restating the diff, no narrative recap, no praise.
- **No file edits.** Read-only review. Suggest changes in findings; do not apply them unless the user explicitly says "apply".
- **No git actions.** Never stage, commit, push, branch, or amend.
- **Negative grep is never sufficient.** Any finding that relies on "I didn't find it" is itself a finding (`Unverified`), not a pass.
- **No invariant → no review.** If no mini-spec and the user can't state the invariant in one sentence, stop and say so.
- **Do not replace `/review`.** This skill is additive. Recommend the user also run built-in `/review` for general code quality if they haven't.
