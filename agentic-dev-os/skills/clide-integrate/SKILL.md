---
name: clide-integrate
description: Prepare completed Clide worker branches for safe human-controlled integration. Use when the repository orchestrator must verify checks at HEAD, request independent Claude/Codex review, preview conflicts, order dependent branches, create a combined-test worktree, or present an explicit merge plan.
---

# Clide Integrate

Prepare integration evidence; do not silently merge, push, delete, or discard work.

## Readiness gate

A task is ready only when:

- its acceptance criteria are addressed;
- required checks passed at the current HEAD;
- blocking findings are resolved;
- changed paths and claims are understood;
- dependency branches are ready or already integrated;
- conflict preview is current.

## Review strategy

Use an independent task with the opposite provider when risk or scope warrants it. The reviewer inspects the branch against its base and publishes findings; it does not implement fixes unless asked.

For multiple compatible branches, use a disposable Clide integration worktree for combined checks. Never use the user's primary checkout as the experiment.

## Order branches

Topologically order dependencies first. Among independent tasks, integrate shared foundations before consumers and refresh conflict previews after every accepted branch. Stop at the first failed gate.

## Ask for authority

Present:

- ordered branches and targets;
- reviewed HEAD SHAs;
- check results;
- overlaps/conflicts;
- rollback/cleanup consequences.

Request explicit confirmation for merge, push, PR publication, or worktree cleanup. Preserve branches and dirty work on failure.

