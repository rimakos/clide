---
name: clide-supervise
description: Supervise active Clide Claude and Codex workers. Use when the repository orchestrator needs a status sweep, must resolve approvals or blockers, coordinate dependencies and path ownership, send durable context, detect stalled work, or summarize which tasks need human attention.
---

# Clide Supervise

Inspect the repository task set through Clide MCP and prioritize attention over activity.

## Triage order

1. Approval requests.
2. Blocked workers and failed setup/checks.
3. Failed or stalled dispatch stages and crashed dev processes.
4. Waiting workers that need a decision or launch capacity.
5. Dependency and path-claim conflicts.
6. Completed workers whose checks or review are stale.
7. Healthy running workers.

Compare recorded check SHA with each task's current HEAD. Treat checks from another SHA as stale.

## Coordinate

- Send concise, durable messages with the decision and its reason.
- Publish repository-wide findings to every affected dependent task.
- Do not inject text into a busy terminal.
- Do not interrupt healthy work merely to request status.
- Do not reassign a claimed path without surfacing the collision.
- Keep provider-specific child agents under their owning Clide task; do not turn them into extra top-level worktrees.
- Use the durable retry control for failed launches; do not create a replacement worktree for an idempotent dispatch.
- Use `clide_request_approval` for actions requiring human authority.

## Detect stalls

Call work stalled only when lifecycle events, elapsed time, and lack of state change support it. Distinguish a long command from an agent waiting for input. Recommend restart/recovery before replacement when a detached session exists.

## Output

Return a compact table or list containing task, provider, dispatch stage, dev health, blocker/decision, changed paths, check freshness, and next action. Omit routine token-by-token activity.
