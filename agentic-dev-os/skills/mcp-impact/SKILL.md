---
name: mcp-impact
description: Use at the END of a branch or at the end of a Claude session where work was completed, to retrospectively decide whether the change just shipped warrants adding, updating, protecting, or skipping MCP tools. Produces a safe, reuse-first MCP Impact Plan. Never writes MCP code. Enforces: no business-logic duplication in MCP tools, no raw DB access, no exposure of tokens/secrets/private data, ownership checks, and approval gates for publishing actions. Triggers on /mcp-impact, "should this have MCP", "mcp plan for this branch", "review mcp impact of what we just did", "any mcp follow-up", "before I open the PR check mcp impact", and as a suggested follow-up after `finishing-a-development-branch` or `goal`.
---

# mcp-impact

## Purpose
After a feature/branch is implemented (or a Claude session has wrapped up its work), look at what actually shipped and decide whether MCP tools should be added, updated, protected, or skipped. Output a compact MCP Impact Plan or a short "No MCP change needed" note. Never writes MCP code.

## When to use
- Slash command: `/mcp-impact`
- Natural language: "should this have MCP", "mcp plan for this branch", "review mcp impact of what we just did", "any mcp follow-up", "before I open the PR check mcp impact", "is there an MCP angle here"
- As a suggested follow-up after `superpowers:finishing-a-development-branch` or `goal`. Recommend it, do not auto-run.

This skill is **retrospective**, not pre-implementation. The input is the change that already exists (diff, branch, recent session work), not a ticket description.

## Inputs

**Required**, one of:
- Current branch (default: compare `HEAD` against `main` via `git diff --stat main...HEAD`)
- Explicit diff / PR reference
- A short summary of what the session just built, if no branch exists

**Optional**:
- Path to existing MCP inventory (file or folder)
- Actor the agent would be serving: end-user / automation / external agent

## Workflow

1. **Identify the change**:
    - If on a branch, run `git diff --stat main...HEAD` and `git log --oneline main...HEAD` (targeted; no full diffs).
    - Otherwise ask the user for a one-paragraph summary of what shipped.
2. **Summarize** the change in one sentence. Identify the domain and the new/changed capabilities.
3. **Locate MCP inventory** (targeted reads only):
    - Probe in order: `mcp/`, `agent-actions/`, `src/mcp/`, `apps/*/mcp/`. Read only `README.md` or an index file if present.
    - If none found, ask the user once for the path. Do not broad-scan.
4. **Apply the MCP Decision Filter** (see below). Output one of: `add` / `update existing` / `protect existing` / `not needed` / `maybe later`.
5. **If `not needed`**: emit a 2–4 line rationale under heading "No MCP change needed" and stop.
6. **If action is required**: map every proposed tool to an existing backend service/use case actually present on the branch. If no backing service exists, mark the tool **blocked**. Do not invent logic inside MCP.
7. **Apply safety rules** (see Hard rules). Mark any action that fails them as `do-not-expose`. If the branch introduced any new endpoint/service that is unsafe to expose, list it under "protect existing" with the guard needed.
8. **Emit the MCP Impact Plan** using the Output template. Omit empty sections. Stop.

## MCP Decision Filter

Pick the strongest applicable label:

- **`add`**: the branch introduced a new service/use case that is valuable to agents and safe to expose (or can be made safe).
- **`update existing`**: the branch changed inputs, outputs, or semantics of a service that an existing MCP tool already wraps. The tool's contract or validation must change.
- **`protect existing`**: the branch widened a surface that an MCP tool exposes (new fields, looser scoping, new side effects). No new tool, but guards/redaction/approval gates must be tightened.
- **`not needed`**: purely UI/UX, internal refactor, or no agent-relevant capability changed.
- **`maybe later`**: valuable but blocked on missing service, approval flow, or unclear ownership.

## Safety rules (always apply)

- No business logic inside MCP tools. Tools are thin adapters over existing services/use cases.
- No raw database access. No raw SQL. No ORM exposure.
- No exposure of tokens, secrets, API keys, refresh tokens, session data, or other users' private data.
- Publishing / side-effecting actions (e.g., publish, send-to-customer, external API call, run automation) require an explicit approval state OR an explicit `confirm: true` argument plus server-side re-check.
- Every tool must enforce ownership: `tenant_id` / `user_id` scoped, verified server-side.
- Every input validated server-side; never trust agent-provided IDs without ownership check.
- Read tools default to the caller's scope only; cross-tenant reads are forbidden.
- Destructive actions (delete, revoke, disconnect an external account) require explicit confirmation argument.
- Rate-limit and audit-log any write tool.

## Output template

```markdown
# MCP Impact Plan — <branch / feature name>

## 1. What shipped
<one-sentence summary of the change, plus domain.>

## 2. Decision
<add | update existing | protect existing | not needed | maybe later>

## 3. Rationale
<2–4 lines. Cite the decision filter criteria.>

## 4. New MCP tools (if `add`)
For each:
- **name**: `<tool_name>`
- **purpose**: <one line>
- **inputs**: <typed fields + which are ownership-scoped>
- **outputs**: <shape; redacted fields noted>
- **backing service / use case**: <existing function/class/path on this branch>
- **ownership check**: <how>
- **approval / safety gate**: <if write/publish>
- **status**: ready | blocked-needs-service | blocked-needs-approval-flow

## 5. Existing MCP tools affected (if `update existing` or `protect existing`)
- **<tool_name>**: <change> — <reason tied to this branch> — <migration note>

## 6. Resources / prompts
- Resources: <e.g., resource://{id}> — read-only, scoped
- Prompts: <named prompt templates the agent should reuse>
(Omit if none.)

## 7. Security & permissions
- Auth: <how the MCP server authenticates the caller>
- Scoping: <tenant / user>
- Approval gates: <which tools require approval state>
- Audit logging: <which tools, what fields>

## 8. Do-not-expose
Explicit list of actions/data from this branch that must NOT surface through MCP, with one-line reason each.

## 9. Backend reuse map
| MCP tool | Existing service / use case | File / module on this branch |
|---|---|---|
| ... | ... | ... |

Tools without a row here are blocked — service must exist first.

## 10. Tests required
- Unit: <service-level — already covered on this branch? or new?>
- MCP adapter: input validation, ownership rejection, approval-gate rejection, redaction
- Integration: <happy path + one rejection case per tool>

## 11. Implementation handoff (Codex / Cursor prompt)
Copy-pasteable prompt:

> Implement the MCP tools / changes listed in sections 4–5 of this plan against the current branch. Strict rules:
> - Each tool is a thin adapter; call the backend service listed in section 9. Do NOT reimplement logic.
> - No raw DB access. No direct ORM queries inside the tool. No new business rules.
> - Enforce the ownership check in section 4/5 for every tool before calling the service.
> - For tools marked with an approval/safety gate, reject the call unless the gate condition is satisfied server-side. Do not trust an agent-provided "approved=true".
> - Never return fields listed in section 8 (do-not-expose). Redact at the adapter boundary.
> - Add the tests listed in section 10 before merging.
> - Do NOT add tools that are marked `blocked-*` in section 4. Stop and report instead.
> - Follow the MCP server's existing registration pattern (see path probed in workflow step 3).
```

## Hard rules

- Retrospective only. Input is shipped code or a session summary, not a future ticket.
- Two-state output: a full MCP Impact Plan, OR a short "No MCP change needed" note. Never both, never code.
- Never write MCP tool files, server code, or schema. This skill plans only.
- Never auto-invoke `finishing-a-development-branch`, `goal`, `ticket-impact`, or any other skill. Recommend, do not run.
- Never broad-scan the repo. Use `git diff --stat` / `git log --oneline` and probe the fixed MCP inventory paths.
- Never fetch external docs unless the user provides a link.
- Stop immediately after emitting the plan or the "No MCP change needed" note.

## Anti-patterns

| Don't | Do |
|---|---|
| Treat this as pre-implementation scoping | Anchor every recommendation to code that already exists on the branch |
| Invent an MCP tool with new business logic | Require an existing service in the reuse map |
| Expose a "run_sql" or "query_db" tool | Mark raw DB as do-not-expose; require a typed service |
| Add a publish/side-effecting tool with no gate | Require approval state + server-side re-check |
| Ignore widened surfaces in existing tools | Use `protect existing` to tighten guards/redaction |
| Trust a `tenant_id` sent by the agent | Verify ownership server-side every call |
| Return raw user records | Redact tokens/PII at the adapter boundary |
| Recommend MCP for a pure-UI branch | Output "No MCP change needed" with reason |
| Auto-run another skill | Recommend it in plain text and stop |
| Dump the full diff into the plan | Reference paths and a one-sentence summary only |

## Example usage

End of a branch that added "one-click re-send of an approved order confirmation to a second recipient":

> /mcp-impact

The skill:
1. Reads `git diff --stat main...HEAD`, sees changes in `orders/send` and a new `ResendConfirmationUseCase`.
2. Probes `mcp/`, finds an existing `send_confirmation` tool.
3. Emits a plan with Decision = `add` + `protect existing`:
   - New tool `resend_confirmation`, backed by `ResendConfirmationUseCase`, requires approval state on the source order, ownership check on both the source order and the target recipient.
   - Update existing `send_confirmation`, tighten scoping now that a second recipient can be targeted.
   - Do-not-expose: auth tokens, refresh tokens, raw recipient records.
   - Handoff prompt for Codex/Cursor.
4. Stops.
