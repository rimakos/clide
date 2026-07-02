---
name: seed-test-data
description: >
  Use when a manual/QA test needs an `<entity>` that already sits in a specific
  `<precondition state>` (a parent record plus its child rows, several steps into a
  multi-stage flow) in the LOCAL/dev database, and that state does not exist to click
  through to, e.g. testing a clone/copy path, a downstream calculation, an edge case
  that needs specific per-child values, or reproducing a bug that depends on exact
  seeded data. Seeds the precondition state directly in SQL so the tester lands at the
  test point. Pairs with the manual-test / ticket-testing skills (which assume the data
  already exists). Triggers: /seed-test-data, "seed test data", "set up precondition
  data", "seed a record with child rows", "I need an <entity> in state X", "reproduce
  this with seeded data". Add `hybrid` to seed the precondition then verify the action
  in the UI.
---

# Seed Test Data

## Overview

Some test points are unreachable offline: the data layer that a test needs is only
ever produced by a live external service (an auth-gated dev API, a marketplace, a
pricing engine) that has no local bypass. When you cannot click through to that state
and there is no rich record to clone, this skill **fabricates the row chain directly in
SQL** on top of a real anchor (an existing parent/owner record). Deterministic, tested
values, offline.

Core artifact: `seed.sql` (in this skill dir). A small set of **knobs** drives every
case. In the template the knobs are:
- `@EntityType`: which variant to build (e.g. two shapes of the same parent that carry
  different child columns).
- `@StopAtStep`: how far into the multi-stage flow to seed (parent only, + first child
  layer, + second child layer). Seed only as deep as the test point needs.

Adapt the knob names to your domain, but keep the pattern: **parameterize at the top,
never edit the body per run.**

## When to use

- A record that needs child rows several steps into a flow (clone paths, downstream
  calc, protected/flagged children, cost/amount columns).
- The deepest child layer (per-child impact/edge rows) for boundary tests.
- Reproducing a bug that depends on specific per-child values.
- **Not** for: tests where the data already exists in the DB (use the manual-test /
  ticket-testing skill), or where authentic service-derived values are the thing under
  test (then run the real flow with the upstream service up).

Note: some fields are non-null bits/flags that stay at a default (e.g. `0`) rather than
`NULL` on the variant that does not use them. Don't assert "all `X* IS NULL`". Read the
actual schema.

## CRITICAL landmines (verify each against YOUR live schema before trusting it)

These are generic seeding hazards, not domain rules. Confirm which apply to your tables.

| Landmine | Rule |
|---|---|
| **System-versioned temporal tables** | NEVER insert the period columns (`ValidFrom`/`ValidTo`, GENERATED ALWAYS). Enumerate columns explicitly; never `INSERT … SELECT *`. |
| **Computed columns** | Never insert a computed column. On MSSQL a computed column requires `SET QUOTED_IDENTIFIER ON` before the insert (else `Msg 1934`). |
| **Local schema = whatever branch last ran migrations** | If migrations auto-run on app startup, to test a branch **run the app on that branch once** so its migrations apply. Branch-only columns only exist on that branch. Gate them behind a knob (`@IncludeBranchCols=1`) so the script still runs on the base schema. |
| **UNIQUE constraints** | Seeding the same natural key twice on one anchor → duplicate-key error (`Msg 2601`). Uniquify the key with a GUID suffix (keep a constant marker prefix for cleanup). |
| **Non-identity PKs (`newsequentialid()` default)** | Supply an explicit `NEWID()` (or your DB's UUID) per row so FKs can be wired in-script. |
| **Branch-specific columns break batch compile** | Keep branch-only inserts in `sp_executesql` (deferred compile) so the script still runs on older schemas. |
| **FKs are NOT `ON DELETE CASCADE`** | `DELETE FROM <parent>` fails (`Msg 547`). Delete children in reverse FK order. Use `cleanup.sql`, never a bare parent delete. |
| **Cleanup also needs the right SET options** | If the delete touches computed columns, `QUOTED_IDENTIFIER` must be ON. Run cleanup via `-i cleanup.sql` (it sets the option), not as a bare `-Q` one-liner. |

## Precondition

At least one existing **anchor** row must exist (the owner/parent the seed hangs off,
e.g. a `customers` row). The script **reuses** that anchor's id; it does not create
owners/users. If none exists the script throws (see `THROW 50001`). Seed base data
first (an app seed endpoint, or restore a DB that has anchors).

## Insert order (FK chain, root first)

`<parent> → <child layer 1> → <grandchild rows>` then optional deeper layers. In the
template: `orders → order_lines` with `customers` reused as the anchor, never created.
Self-referencing FKs (a child pointing at another child) → insert parents first, or
remap after. Always insert root-down, delete leaf-up.

## How to run (default: execute via sqlcmd)

This skill lives in your agentic OS, **not** in any product repo. It is never committed.
Paths below are absolute; the target is your local/dev DB. Resolve the DB host/name from
`os-config.yaml` (or an env var); the template below shows a local Docker MSSQL as an
example.

Knobs are **sqlcmd `-v` parameters**. Never edit the script (keeps it clean for the
next caller). Pass all of them; override only what your test case needs.

1. Run (full default command, a variant-A entity through step 2):
   ```bash
   SQLCMDPASSWORD='<db-password>' sqlcmd -S localhost,1433 -U sa -d <database> -C \
     -i ~/.claude/skills/seed-test-data/seed.sql \
     -v EntityType=1 StopAtStep=2 IncludeBranchCols=0 \
        EntityName="SEED-TEST order" RefDate=2026-01-01 \
        Amount=600.00 Rate=0.05 ChildAmount=700.00
   ```
   Other variant → change `-v EntityType=0`. Stop earlier/later → `StopAtStep=1|3`.
   Branch columns → `StopAtStep=3 IncludeBranchCols=1` only on a migrated-branch DB.
2. It prints the new root id. Open that record in the app at the relevant step.
3. Cleanup (removes ALL `SEED-TEST` rows + subtrees, reverse FK order, correct SET
   options):
   ```bash
   SQLCMDPASSWORD='<db-password>' sqlcmd -S localhost,1433 -U sa -d <database> -C -i \
     ~/.claude/skills/seed-test-data/cleanup.sql
   ```

Verify seeded rows (include any SET option a computed column needs):
```bash
SQLCMDPASSWORD='<db-password>' sqlcmd -S localhost,1433 -U sa -d <database> -C -h -1 -W -Q \
 "SET QUOTED_IDENTIFIER ON;
  SELECT l.* FROM order_lines l
  JOIN orders o ON o.id = l.order_id
  WHERE o.reference LIKE 'SEED-TEST%';"
```

Every seeded root is tagged `SEED-TEST` in a name/reference field for find + cleanup.
Verify the round-trip on your own schema: seed → open → cleanup → 0 rows.

## hybrid mode

`/seed-test-data hybrid` → seed only the **precondition** rows (the tedious setup), then
the tester performs the **action under test** (clone, edit, re-run the flow) in the UI
and verifies. Use for bug-repro where the setup is the cost and the action is the point.
Output is the seeded root id + the exact UI steps + the verification SQL. It does not
fabricate the post-action state.

## Adapting to a new test case

1. State the test point (which step, what must be true per child row).
2. Confirm the local DB is migrated to the branch under test (run the app on it once if
   unsure).
3. Pull the required (non-null, no-default, non-computed) columns for any new table you
   add:
   ```sql
   SELECT name FROM sys.columns
   WHERE object_id = OBJECT_ID('<Table>')
     AND is_nullable = 0 AND default_object_id = 0
     AND is_computed = 0 AND generated_always_type = 0;
   ```
4. Sample enum/int values from existing rows or the source code enum; don't guess.
5. Add the rows, keeping branch-only columns inside `sp_executesql`.

## Common mistakes

- `INSERT … SELECT *` from a template row → fails on temporal/computed columns.
  Enumerate columns.
- Forgetting the SET option a computed column needs before the insert → `Msg 1934`.
- Enabling branch columns on a DB that hasn't migrated the branch → `Invalid column
  name`. Migrate first (run the app on the branch).
- Re-seeding the same natural key on one anchor → duplicate-key error. The script
  auto-uniquifies; don't remove that.
- Fabricating authentic service-derived values by hand for a calc test → can't be
  trusted; run the real flow for calc-authenticity tests.
- `DELETE FROM <parent> WHERE …` → fails (`Msg 547`, FKs don't cascade). Use
  `cleanup.sql`.
- Running cleanup as a bare `-Q` one-liner when it touches computed columns → `Msg 1934`.
  Run it via `-i` (the file sets the SET options).
- Leaving seeded data behind → always run the cleanup script (matches the `SEED-TEST`
  tag).
