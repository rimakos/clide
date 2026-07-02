# Spec-Driven Cross-Repo Ticket Workflow

Short workflow for tickets that touch a contract, a data shape, or more than one
repo. Source of truth for topology: [`../system-map.md`](../system-map.md). When
the map and this workflow disagree, fix the map first.

Resolve `{{repos}}` and `{{seams}}` below from `os-config.yaml`.

## When to use this workflow

Use when the ticket touches **any** of:

- An endpoint or callback across a seam listed in `os-config.yaml`.
- A DTO/contract in a shared library consumed by multiple repos.
- A message-bus topic / event schema.
- A DB schema change (owned by whichever repo owns migrations).
- Anything with the words **handoff, precision, serialization, persistence,
  cloning, migration, contract, generated client** in the description.

Don't use it for: single-repo UI tweaks, isolated bug fixes with no contract
change, copy/style edits.

## Step 1 — Invariant first

Write the invariant **before** opening any file. One or two sentences. Examples:

- "Decimal precision on `<field>` is preserved end-to-end: producer payload ->
  backend handler -> DB column -> readback."
- "`<operation>` is idempotent on `(<key1>, <key2>)`; a second call returns the
  same result without creating a duplicate."
- "An id resolved on Day N still resolves on Day N+1, even after the nightly ingest."

If you can't state the invariant, you don't have a spec yet. Stop and clarify.

## Step 2 — Evidence ranking

When evidence conflicts, trust in this order:

1. Production data rows, captured payloads, prod log lines.
2. Code at the call site (the actual handler / serializer / migration).
3. Tests that currently pass.
4. Documentation, comments, README.
5. Negative grep results — **never** conclusive.

Cite the highest-ranking evidence you have for every claim in the plan.

## Step 3 — System touch map

List every surface the ticket touches. One row per repo/seam from `os-config.yaml`.

| Surface                          | Touched? | Why |
|----------------------------------|----------|-----|
| `<repo>` backend handler / DTO   |          |     |
| `<repo>` message-bus topic       |          |     |
| migrations repo                  |          |     |
| shared library (version bump)    |          |     |
| `<repo>` generated client        |          |     |
| ... one row per repo/seam        |          |     |

If a row is checked, name the file. If unchecked, state why the invariant doesn't
reach it.

## Step 4 — What to change vs. what NOT to change

- **Change** only the rows checked above, and only the files named.
- **Do not change** any repo the user has not explicitly named for this ticket.
- **Do not** refactor adjacent code, rename for style, or "clean up" along the way.
- **Do not** add backward-compat shims for callers that don't exist yet.
- Generated clients must be regenerated in the same PR as the backend change that
  triggered them.

## Step 5 — Out-of-scope evidence

For each surface you marked **unchecked**, write one line of positive evidence that
the invariant holds without changing it. "I didn't see it touched" is not evidence —
a file:line or a captured payload is.

## Step 6 — Tests validate the invariant

- At least one test states the invariant in its name.
- For precision/serialization invariants: round-trip test that asserts the exact
  wire value, not a tolerant approximate match.
- For handoff/API invariants: write the contract field and read the same field back.
  No mocks for the contract field itself.
- For schema: a migration **plus** a test that exercises the new column.

## Pre-implementation checklist

- [ ] Invariant written in one or two sentences.
- [ ] Highest-rank evidence cited for the current behaviour.
- [ ] System touch map filled in; unchecked rows have positive evidence.
- [ ] Repos to be modified match what the user named.
- [ ] Generated-client regeneration plan named (which client, where).
- [ ] Migration filename drafted if schema is touched.

## Pre-PR checklist

- [ ] Invariant still holds; test names reflect it.
- [ ] Round-trip / idempotency / precision test passes locally.
- [ ] Regenerated client committed alongside the backend diff.
- [ ] Migration deployed before any code path that depends on it.
- [ ] Shared-library version bumps deliberate and called out in the PR description.
- [ ] No files changed in repos the user did not name.
- [ ] System map updated if any ✅ / 🟡 / ⬜ statement changed.
