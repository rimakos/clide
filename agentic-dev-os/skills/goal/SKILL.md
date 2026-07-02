---
name: goal
description: Use at the END of a finished ticket to capture non-obvious implementation decisions as a compact ADR in `wiki/decisions/`. Triggers on `/goal`, "log the decision", "write the ADR for this ticket", "record this ticket's decisions". Matches the workspace wiki style: evidence-first, scope-disciplined, compact. Only writes an ADR when the decision would surprise a future reader. Routine tickets are skipped.
---

# goal

## Purpose

Capture *non-obvious* implementation decisions from a finished ticket as a
compact ADR (Architecture Decision Record) in the workspace's coordination
memory. Future-you and future-Claude recover the *why* without re-reading
the diff.

ADRs live in `wiki/decisions/`: local coordination memory, nothing ships
(same philosophy as `wiki/system-map.md` and `wiki/workflows/`).

## When to use

- Slash command: `/goal`
- Natural language: "log the decision", "write the ADR for this ticket",
  "record this ticket's decisions", "/goal for this PR"

Only at the **end** of a ticket, after implementation is complete. Not a
planning tool.

## Inputs

**Required**:
- Ticket id or short title (free text if no id).

**Optional**:
- Repo + branch/PR (skill will read git state if given).
- Invariant from a prior `/ticket-impact` run: reuse verbatim if present
  in the conversation.

## Workflow

1. **Decide if an ADR is warranted.** Skip routine tickets. Write only when
   a future reader would be surprised, e.g. picked X over Y, locked in a
   constraint, removed a public surface, changed a pattern. If skipping,
   say so in one line and stop.

2. **Gather minimal evidence.** Run only these targeted commands (no broad
   scans, no diff re-reads beyond stat):
   - `git log <base>..HEAD --format="%h %s"`: commit subjects.
   - `git diff --stat <base>..HEAD`: file-level shape.
   - `git diff --diff-filter=DA --name-status <base>..HEAD`: added/deleted
     files (the loudest signal of a structural choice).
   - Base branch: detect via `git symbolic-ref refs/remotes/origin/HEAD`.

3. **Restate the invariant.** One or two sentences, matching the style of
   the workspace wiki's cross-repo ticket workflow (`wiki/workflows/`) Step 1.
   If `/ticket-impact` already produced one in this conversation, reuse it
   verbatim, do not paraphrase.

4. **Pick the next ADR number.** Read filenames in the workspace wiki's
   `decisions/` directory (create it if it does not exist). Next number =
   max existing + 1, zero-padded to 4 digits. If empty, start at `0001`.

5. **Draft the ADR** using the output template below. Keep it ≤ ~40 lines.
   Cite file paths (and line numbers when known) per the wiki's
   evidence-ranking convention. Do not paste diff hunks.

6. **Write two files**:
   - `wiki/decisions/NNNN-<kebab-title>.md`: the ADR.
   - `wiki/decisions/README.md`: append one index line. Create the file if
     missing using the index template below.

7. **Update wiki navigation** (if `wiki/index.md` and `wiki/log.md` exist):
   - `wiki/index.md`: add one line under `## Decisions`.
   - `wiki/log.md`: append `## [YYYY-MM-DD] decision | <title>` with a
     one-bullet summary.

8. **Echo the path + one-line summary. Stop.**

## Output template

### ADR file (`NNNN-<kebab-title>.md`)

```markdown
# NNNN — <Title>

- **Date:** YYYY-MM-DD
- **Ticket:** <id or "n/a">
- **Status:** Accepted
- **Repos touched:** <comma-separated repo names, resolved from os-config.yaml>

## Invariant
<one or two sentences — the contract the change preserves>

## Decision
<what was done, 1-3 sentences>

## Why this, not the alternative
<the non-obvious part — the option considered and rejected, and the reason.
This is the section that justifies the ADR's existence. If it would be
trivial, the ticket did not need an ADR — go back to step 1.>

## Evidence
- <file:line, payload, migration name, or commit hash — highest-rank
  evidence per the wiki's evidence ranking>

## Consequences
- <follow-ups, things now constrained, things to watch>
```

### Index file (`README.md`)

If creating, use this header:

```markdown
# wiki/decisions — Implementation Decision Records

Compact ADRs for non-obvious choices made while finishing tickets. Same
philosophy as the rest of the wiki: local coordination memory, nothing
ships. Written by `/goal` at ticket end. Routine tickets are not recorded
here.

## Index

- [NNNN — Title](NNNN-kebab-title.md) — one-line hook
```

Append each new ADR as a single line under `## Index`, newest at the bottom.

## Hard rules

- **Stop after writing the ADR + index line.** No auto-chaining into other
  skills, no follow-up suggestions beyond what's in *Consequences*.
- **Skip routine tickets.** If the "Why this, not the alternative" section
  would be trivial or empty, do not write an ADR. Say so and stop.
- **Work-only.** Personal-project ADRs go to a personal vault, not the
  workspace wiki.
- **Targeted reads only.** Use the four git commands listed in Workflow
  step 2. Do not open files, do not grep the codebase, do not fetch PR
  pages. The diff stat + added/deleted file list is enough to write the
  ADR; if it isn't, ask one question rather than scanning.
- **Reuse the invariant verbatim** when `/ticket-impact` produced one in
  this conversation. Do not paraphrase or "improve" it.
- **Cite, don't paste.** Reference `file:line` or filenames. No diff hunks
  in the ADR.
- **One ADR per ticket.** If a ticket bundles two unrelated decisions,
  write two ADRs with sequential numbers.
- **Never modify product repos.** ADRs live only under `wiki/decisions/`.
  Do not commit anything in any workspace repo.
- **No git actions.** Do not stage, commit, or push the new ADR. Writing
  the file is enough.

## Anti-patterns

| Don't | Do |
|---|---|
| Write an ADR for every ticket | Skip routine work; ADRs are for non-obvious choices |
| Paste diff hunks as evidence | Cite `file:line` or filenames |
| Paraphrase the invariant from `/ticket-impact` | Reuse it verbatim |
| Broad-scan the repo to "understand" the change | Use the four targeted git commands |
| Pad the *Consequences* section | Omit it if there's nothing to watch |
| Number ADRs by date or ticket id | Sequential zero-padded number, simple max+1 |
| Commit the ADR in a workspace repo | Write only under `wiki/decisions/` |

## Example usage

User, at end of a finished ticket:

```text
/goal PROJ-1234 — consolidate order configuration into request-order, in the service repo
```

Skill:

1. Reads `git log` + `git diff --stat` + added/deleted files vs the default
   branch.
2. Notices: `UpdateOrderConfiguration` command/handler/validator + form
   removed; `RequestOrder` expanded; the generated client regenerated.
3. That's a structural consolidation, so an ADR is warranted.
4. Next number: scans `wiki/decisions/`, picks `0001`.
5. Writes `wiki/decisions/0001-consolidate-order-configuration-into-request-order.md`.
6. Appends index line to `wiki/decisions/README.md`.
7. Echoes:

   ```text
   Wrote wiki/decisions/0001-consolidate-order-configuration-into-request-order.md
   Summary: Merged UpdateOrderConfiguration into RequestOrder; single command, single validator.
   ```

8. Stops.

Counter-example, routine ticket:

```text
/goal PROJ-1299 — fix typo in error message
```

Skill responds:

```text
No ADR needed — typo fix has no non-obvious decision. Skipping.
```

Then stops.
