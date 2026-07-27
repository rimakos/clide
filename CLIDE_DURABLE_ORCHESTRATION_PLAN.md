# Clide durable orchestration plan

Status: implemented and verified on `codex/durable-orchestration` on 2026-07-21.

This plan turns Clide from a multi-terminal worktree launcher into a durable local
control plane for Claude Code and Codex. A repository has one coordinating session,
while every implementation task owns an isolated branch, worktree, provider session,
development terminal, lifecycle record, and audit trail.

## Product model

- One canonical repository has at most one pinned Repository Orchestrator.
- The orchestrator may be Claude or Codex, but is launched with a read-only posture.
- Workers may be any mix of Claude and Codex and never share a checkout.
- Ordinary shell and dev-server terminals are children of a worker tile and use that
  worker's worktree and environment.
- Dispatch is a durable state machine, not a renderer-only sequence of side effects.
- Clide remains the authority for worktrees, ports, leases, task state, approvals,
  and integration gates. Provider CLIs remain the authority for their transcripts.

## Operator workflow

1. Open a repository and use its pinned orchestrator to turn raw work into a worker
   specification: ticket, title, branch, base, provider, prompt, dependencies, path
   claims, setup command, and dev command.
2. Clide validates repository scope, idempotency, branch ownership, dependency
   cycles, path-claim risk, provider availability, and worker capacity.
3. Clide creates the isolated worktree, assigns an available local port, performs
   setup, launches the provider, waits for meaningful provider output, and writes
   the prompt exactly once.
4. The task tile exposes the agent terminal plus any number of ordinary terminals.
   A dev terminal can run the branch independently and reports starting, healthy,
   unhealthy, crashed, stopped, and its local URL.
5. The orchestrator Inbox summarizes blocked work, approvals, dependencies, overlap,
   audit events, and recovery actions. It also owns the durable repository brief.
6. Completion still goes through review, checks, conflict preview, and an explicit
   operator-controlled integration action.

## Durable dispatch lifecycle

```text
requested
  -> worktree-created
  -> waiting-dependencies | waiting-capacity
  -> setup-running
  -> launching
  -> provider-ready
  -> prompt-delivered
  -> running
```

Any active stage can fail or be cancelled. Recoverable failures use bounded
exponential backoff and stop after five attempts. A prompt whose write was recorded
but not acknowledged is never silently sent again; it becomes an explicit recovery
decision. Each transition is revision-checked, leased, timestamped, and audited in
the local transactional state store.

## Reliability and scheduling

- Claim leases prevent two renderer instances from launching the same worker.
- Renderer reload releases abandoned renderer leases and reconciles against the
  main process's authoritative live-session inventory.
- Provider start is single-flight in both main and renderer processes.
- A worker does not receive its prompt until provider readiness is observed from
  terminal output, and prompt delivery is acknowledged only by subsequent output.
- Dispatch keys make repeated orchestrator calls idempotent.
- Dependency references accept task IDs, tickets, or dispatch keys; cycles are
  rejected before launch and dependants wake immediately when prerequisites finish.
- Per-repository concurrency defaults to five active workers and is configurable.

## Coordination and context

- Repository context stores a summary, constraints, useful commands, conventions,
  and decisions. Workers receive a bounded snapshot so later edits cannot silently
  rewrite the brief of an already-dispatched task.
- Path claims are repository-relative and support `*`, `**`, and `?`. Direct
  intersections are high risk; shared static hotspots are medium risk.
- Workers can publish findings, checks, messages, artifacts, and approval requests.
- The orchestrator Inbox is a human control surface rather than an autonomous merge
  queue: approvals, retries, cancellation, and integration remain explicit.

## Security model

- Claude orchestrators use plan permission mode; Codex orchestrators use a read-only
  sandbox with on-request approval.
- Orchestrator MCP mutations are repository-scoped and role-checked.
- State directories use mode `0700`; the database and sidecars use `0600`.
- Prompts are written directly to provider PTYs and never interpolated into a shell.
- Ports are probed through the operating system before worktree creation.
- Existing renderer isolation, allowlisted preload API, private authenticated socket,
  worktree-scoped filesystem access, and explicit Git authority remain intact.

## Interface changes

- The inspector's Inbox replaces a passive message-only view.
- Worker Inbox: lifecycle runway, dependency and claim details, dev health, approval
  cards, audit timeline, Retry, and Cancel.
- Orchestrator Inbox: repository brief editor plus the cross-worker attention queue.
- Task cards expose dispatch stage, dev port/health, and overlap severity.
- A restored tile reconnects to its agent, shells, and dev terminal after reload.

## Acceptance criteria

- [x] Codex orchestrator dispatches a Claude worker.
- [x] Claude and Codex workers can coexist across five isolated worktrees.
- [x] Setup, provider readiness, prompt write, prompt acknowledgement, and running
  state are recorded as distinct durable transitions.
- [x] Reload during dispatch restores exactly one worker session.
- [x] Repeating a dispatch key returns the existing task.
- [x] Dependencies, cycles, worker capacity, glob path claims, and real port
  allocation are covered by unit tests.
- [x] Every task can own an independent persistent dev terminal.
- [x] Orchestrator context, approval requests, audit history, and recovery controls
  are visible in Inbox.
- [x] Repository orchestrators are constrained to a read-only provider posture.
- [x] Clide orchestrator skills describe dispatch, supervision, and integration using
  the new lifecycle.
- [x] Final full check, supervisor smoke, packaging, installed-skill refresh, and
  reopened-app verification.

## Deliberately retained human gates

Clide does not automatically merge, push, delete worktrees, approve privileged
commands, resolve uncertain prompt delivery, or choose conflict resolutions. Those
actions are consequential and remain visible operator decisions even when the rest
of the pipeline is automated.
