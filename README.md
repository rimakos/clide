# Clide — the Claude + Codex branch flight deck

Clide is a focused macOS IDE for supervising several Claude Code and Codex tasks
without putting them in the same checkout. One task owns one Git worktree, one
branch, one agent session, a durable coordination record, and as many ordinary
shell terminals as you need.

## Daily workflow

1. Open a repository with `clide .`.
2. Choose **New isolated task**, enter a ticket/title, provider, and optional setup
   and dev commands.
3. Clide creates a worktree under `~/.clide/worktrees`, assigns a free dev port,
   runs setup, starts Claude or Codex, and optionally starts the dev command in its
   own terminal.
4. Use the single, two-column, two-row, or four-pane layout to supervise tasks.
5. Review dependencies, child agents, lifecycle events, path claims, artifacts,
   messages, checks, changed-file overlap, and dry conflict previews in the inspector.
6. Merge only through the explicit guarded integration action. Clide requires a
   clean target checkout and clean preview, and never pushes automatically.

Each agent pane has **+ Shell** for dev servers, tests, logs, database commands, or
anything else in that exact worktree. `⌘⇧J` opens a shell, `Ctrl+Tab` cycles that
task's terminals, and a shell can be renamed by double-clicking its tab.

## Repository orchestrator

The first session for a repository is its pinned **Repository Orchestrator**. It can
be Claude or Codex and receives workspace-scoped Clide MCP tools. Ask it to dispatch
a ticket and it will define the branch, provider, prompt, commands, dependencies,
and path claims; Clide then creates and launches the isolated worker automatically.
The orchestrator coordinates the primary checkout but does not implement worker
tickets there. Dispatch is durable across reloads, provider startup and prompt
delivery are acknowledged separately, and uncertain delivery requires an explicit
operator decision. See [CLIDE_DURABLE_ORCHESTRATION_PLAN.md](CLIDE_DURABLE_ORCHESTRATION_PLAN.md).

## Flight-deck features

- Claude Code and Codex provider adapters with resume support and CLI detection.
- Isolated Git worktrees with duplicate branch ownership protection,
  `.worktreeinclude`, setup commands, and safe cleanup checks.
- Four-pane agent grid, focus mode, attention states, task rail, and collapsible
  inspector.
- Per-task dev ports and optional automatic dev-server terminals.
- A durable dispatch state machine with revision-checked transitions, renderer
  leases, bounded retries, exactly-once launch guards, and reload recovery.
- Dependency scheduling with cycle detection and a configurable per-repository worker
  limit, plus glob-aware path-claim risk before launch.
- An Inbox for lifecycle recovery, approvals, audit history, dev health, and a durable
  repository brief whose bounded snapshot is delivered to each worker.
- Transactional local tasks, findings, messages, checks, layout, metrics, and recovery
  state in `~/.clide/state.db`, including automatic migration from the old JSON store.
- A local Clide MCP server, automatically scoped into isolated Claude and Codex
  sessions, so either provider can publish findings and check results.
- Native Claude hooks and Codex notifications for attention and child-agent state.
- Dependencies, path claims, artifacts, changed-path overlap, checks at a commit SHA,
  hunk staging, independent AI review, and disposable combined-test integration.
- Detached agent and shell processes that reattach after Clide restarts.
- Credential-free workspace backup/restore, local-only workflow metrics, signed
  release automation, in-app updates, release channels, and rollback metadata.
- Typed text, Markdown, code, image, HTML-sandbox, and Git diff viewers.
- A setup doctor, authenticated Unix-socket `open`/event shim, single-instance launcher,
  secure Electron preload boundary, file-size limits, and worktree-scoped file IPC.

## Install and run

Requirements: macOS, Node.js 22.12+, Git, and at least one of `claude` or `codex` on
your login-shell PATH.

```bash
git clone https://github.com/rimakos/clide.git
cd clide
./bin/install
clide .
```

Development:

```bash
npm install
npm run rebuild
npm run check
npm start
```

Use `npm run doctor` for a JSON environment report. See [INSTALL.md](INSTALL.md) for
manual installation and troubleshooting.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` | sessions and history |
| `⌘⇧J` | shell in the active task |
| `Ctrl+Tab` | next terminal inside the task |
| `⌘1…9` | focus an agent |
| `⌘⇧1…9` | queue a message for an agent |
| `⌘\` | grid/focus toggle |
| `⌘I` | inspector toggle |
| `⌘B` | task/file rail toggle |
| `⌘P` | file search |

## Agentic-dev-os

The optional [agentic-dev-os](agentic-dev-os/) supplies lifecycle and workspace-wiki
skills. The Welcome action and `npm run setup-os` install the same canonical skills
for both Claude (`~/.claude/skills`) and Codex (`~/.agents/skills`). Nothing is
installed globally unless you choose that action.

Repository orchestrators use the bundled `clide-orchestrate`, `clide-dispatch`,
`clide-supervise`, and `clide-integrate` skills. Install only those four without
touching other bundled skills using `npm run setup-os -- --orchestrator`.

Claude orchestrators start in plan mode and Codex orchestrators start in a read-only
sandbox. Both coordinate through repository-scoped Clide tools and request approval
for consequential operations.

## Safety model

The renderer has no Node.js access. It talks through an allowlisted preload API;
filesystem operations are constrained to granted workspaces, HTML previews are
script-disabled, external navigation is denied by default, and the file-open shim
uses a private local Unix socket and stable secret. Clide never silently stages
everything, commits, pushes, force-removes a dirty worktree, or integrates without a
named user action.

Clide state and coordination stay local. Provider authentication and transcripts
remain owned by their official CLIs.
