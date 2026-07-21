# Clide repository orchestrator

Status: implemented and verified on 2026-07-21

## Product decision

Every canonical Git repository owns at most one persistent orchestrator session. The
orchestrator may run Claude or Codex, stays in the primary checkout, and coordinates
instead of implementing tickets there. Implementation work belongs to isolated Clide
worker tasks and worktrees.

## Workflow

1. Opening a repository restores or creates its orchestrator and pins it ahead of
   worker sessions.
2. The orchestrator uses workspace-scoped Clide MCP to read repository tasks.
3. `clide_dispatch_task` accepts ticket, title, complete worker prompt, provider,
   branch/base, setup/dev commands, dependencies, path claims, and a dispatch key.
4. Clide validates repository scope, provider availability, duplicate branch/task
   ownership, and idempotency before creating the worktree.
5. The renderer runs setup, opens the worker tile, sends the prompt directly to the
   provider PTY, and optionally starts the dev terminal on the allocated port.
6. The orchestrator supervises lifecycle events, blockers, checks, findings, and
   integration readiness through durable coordination records.

## Skills

- `clide-orchestrate`: role boundary and repository flight-deck loop.
- `clide-dispatch`: convert raw work into a complete isolated-worker specification.
- `clide-supervise`: triage approvals, blockers, dependencies, overlap, and stale checks.
- `clide-integrate`: review, combined testing, ordering, and explicit integration authority.

The skills are bundled under `agentic-dev-os/skills` and install into both Claude and
Codex with `npm run setup-os -- --orchestrator`.

## Safety invariants

- One orchestrator per canonical repository.
- Orchestrator commands cannot target another repository.
- Retried dispatch keys return the existing active task.
- Prompts go to PTY input, never through shell interpolation.
- Worker startup failure preserves a blocked, recoverable task/worktree.
- Dependencies can create a task but prevent premature launch.
- Merge, push, cleanup, and destructive Git actions remain explicit user decisions.

## Acceptance record

- Claude orchestrator → Codex worker dispatch passed during development.
- Codex orchestrator → Claude worker dispatch is covered by the deterministic E2E suite.
- Full prompt delivery into the worker terminal is asserted.
- Duplicate dispatch is asserted idempotent.
- Repository scoping, pinned identity, durable creator metadata, and cleanup are asserted.
- Existing five-worktree mixed-provider and hunk-staging regression suite remains green.

