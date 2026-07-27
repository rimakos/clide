# Clide contributor guide

Clide is a macOS Electron terminal IDE for running coding-agent sessions. It
launches Claude Code and Codex through `node-pty`, supports task-bound auxiliary
shells, and creates isolated Git worktrees for parallel work.

Before planning a substantial product change, read
`docs/CLIDE_IDE_IMPROVEMENT_PLAN.md` and check the current repository state. Preserve
unrelated and untracked user work.

## Current architecture

- `main.js`: Electron main process, agent/shell PTY lifecycle, provider detection,
  Claude transcript discovery, Git/worktree and filesystem IPC, and the local
  `open` shim server.
- `renderer/renderer.js`: session tabs, xterm terminals, file/diff viewers,
  history, Git controls, persistence, and keyboard shortcuts.
- `renderer/index.html` and `renderer/style.css`: the complete renderer UI.
- `shim/open`: routes agent `open <path>` calls back into Clide.
- `agentic-dev-os/`: optional lifecycle skills and workspace templates. It is
  currently packaged for Claude Code; do not assume Codex parity.

## Working rules

- Keep provider-specific behavior behind a provider adapter. New core session,
  worktree, task, and UI state must not depend on Claude transcript internals.
- A parallel coding session must own an isolated working directory. Never make
  multiple active sessions share a checkout that one session can branch-switch.
- Treat agent output, repository files, transcript metadata, branch names, and
  IPC payloads as untrusted input. Pass process arguments as arrays; do not build
  shell command strings from them.
- Keep terminal access as a first-class escape hatch even when structured agent
  events are available.
- Do not add silent commit, push, merge, reset, worktree removal, or broad staging
  behavior. Destructive and publishing actions require explicit user intent.
- Preserve macOS support. If cross-platform support is added, isolate it behind
  platform services rather than scattering platform checks through the UI.

## Current verification

There is no automated test suite yet. For changes to the existing JavaScript,
run at minimum:

```bash
node --check main.js
node --check renderer/renderer.js
npm ls --depth=0
```

For PTY or Electron changes, also run `npm run rebuild` and manually launch with
`npm start`. Document any verification that could not be run.
