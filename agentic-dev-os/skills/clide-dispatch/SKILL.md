---
name: clide-dispatch
description: Convert a ticket, bug, feature request, or implementation prompt into a validated isolated Clide worker. Use when the repository orchestrator should choose Claude or Codex, define the ticket metadata, branch, base ref, setup/dev commands, dependencies, path claims, and a self-contained worker prompt, then launch the task through Clide MCP.
---

# Clide Dispatch

Create one bounded worker task. Never implement the ticket in the orchestrator checkout.

## Build the task specification

Extract or infer:

- ticket identifier and concise title;
- implementation outcome and acceptance criteria;
- provider (`claude` or `codex`);
- base ref and `clide/<ticket-or-slug>` branch;
- setup and dev commands from workspace conventions;
- task dependencies;
- expected path claims;
- checks the worker must run.

Prefer the orchestrator's provider when either provider is equally suitable. Preserve a provider explicitly chosen by the user.

## Write the worker prompt

Make it executable without this conversation. Include scope, acceptance criteria, relevant paths, dependencies, required validation, constraints, and the instruction to publish blockers/findings/checks through Clide. Tell the worker not to commit or push unless the user requested it.

Do not include secrets, hidden transcripts, or unsupported assumptions.

## Validate before dispatch

1. Read existing Clide tasks.
2. Read the repository brief and rely on Clide to snapshot it into the worker prompt.
3. Reject duplicate active ticket or branch ownership.
4. Use repository-relative glob claims and flag high/medium overlap.
5. Keep unfinished dependencies attached to the task; reject missing references and cycles.
6. Use a stable dispatch key so retries recover the existing lifecycle instead of creating another worker.

Call `clide_dispatch_task` only after the specification is complete. Do not create Git worktrees or start provider CLIs manually.

A `setupCommand` you supply is arbitrary shell, so Clide holds the worker at `waiting-approval` until the user approves that exact command. Keep it to the repository's documented install/build step, and expect a launch to pause there. Omit it entirely when the worker does not need one.

## Report

Return the task, provider, branch, worktree, port, dependencies, dispatch stage, and whether it launched or remained queued. If creation partially succeeds, preserve the recoverable task and report the exact failed stage.
