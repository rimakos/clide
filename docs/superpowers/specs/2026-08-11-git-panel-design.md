# Git panel — JetBrains-style rebuild

Date: 2026-08-11
Status: Phase 0 and Phase 1 approved; Phases 2 to 4 need their own specs.

## Problem

The git panel has five reproducible defects and one behaviour mismatch.

| # | Defect | Evidence |
|---|---|---|
| 1 | Files whose names git quotes (non-ASCII, escapes) cannot be staged. `git-status` strips the surrounding quotes but never unescapes the octal, so git receives a literal `caf\303\251.txt`. | `fatal: pathspec 'caf\303\251.txt' did not match any files` |
| 2 | `git push` on a branch with no upstream always fails. `main.js` issues a bare `push`. | `fatal: The current branch feature-x has no upstream branch.` |
| 3 | Push with no remote surfaces only the first stderr line. | `fatal: No configured push destination.` |
| 4 | Nothing ever fetches, so ahead/behind is read from a stale remote ref and "behind" is permanently 0. | Phase 2 |
| 5 | `git-status` treats every failure except "not a git repository" as success, returning `{repo:true, files:[]}`. The panel then renders branch `HEAD` and "No changes" over a broken repo. | `main.js` status handler |
| 6 | Commit auto-stages everything when nothing is staged. Not a defect, a mismatch: JetBrains never does this. | `renderer.js` commit handler |

## Layout decision

Git stays a mode of the existing right panel. Diffs open as panel tabs. No new
split, no bottom tool window.

```
┌──────────────────┬─────────────────────┐
│                  │ [Files] [Git*]      │
│                  ├─────────────────────┤
│   claude         │ main  ↑2 ↓1     ⟳   │
│   terminal       │ ┌─────────────────┐ │
│                  │ │ commit message  │ │
│                  │ └─────────────────┘ │
│                  │ [Commit] [+Push]    │
│                  │ ▾ Changes (3)       │
│                  │  ☑ M  main.js       │
│                  │  ☑ A  settings.json │
│                  │  ☐ M  README.md     │
└──────────────────┴─────────────────────┘
```

## Phase 0 — correctness

Confined to `main.js`. No UI change.

- Status runs `git status --porcelain=v1 -z -b -uall` and parses on NUL.
  Verified format: the branch header is a single field (`## main...origin/main [ahead 2]`,
  or `## HEAD (no branch)` when detached); a rename is two consecutive fields,
  new path first then old; paths are raw bytes with no quoting.
- `runGit` sets `GIT_TERMINAL_PROMPT=0` so a push that needs credentials fails
  with a message instead of blocking on a prompt that has no terminal.
- Read-only git calls set `GIT_OPTIONAL_LOCKS=0` so status polling does not
  contend with the terminal's git over `index.lock`.
- `runGit` returns the exit code and the full stderr. The toast still shows the
  first meaningful line; the full text stays available.
- `git-status` returns `{error}` for failures other than "not a git repository".
- `git-push` resolves `@{u}` first and falls back to `push -u origin HEAD`.

## Phase 1 — Commit window

The Staged/Changes split and drag-and-drop are removed. One Changes tree with a
checkbox per file.

A checkbox means "include in this commit", not "is staged". On commit, Clide
stages any checked untracked path, then runs `git commit --only -- <checked>`.
The index is otherwise left alone, matching JetBrains. Paths already staged from
the terminal come up pre-checked and keep their status letter.

Also in this phase: folder tree grouping with collapsible nodes, select-all in
the zone header, an Amend checkbox that prefills the message from
`git log -1 --pretty=%B` and commits with `--amend`, and a Commit and Push action.

`renderer.js` is 1006 lines already carrying the terminal, tabs, viewers, file
tree and git. The git UI moves to `renderer/git.js` as part of this phase so the
later phases have somewhere to land.

## Phase 2 — Update / Push flow

- `git-fetch` runs `fetch --prune` on a three minute timer and once four seconds
  after launch. Failures are silent: being offline is not worth a toast.
- `git-update` runs `pull --rebase`, and refuses up front on a branch with no
  upstream rather than letting git fail.
- Push opens a dialog listing the commits it would send, resolved by
  `git-outgoing`. With no upstream the range becomes `HEAD --not --remotes`, so a
  new branch lists only its own commits rather than all of history.
- Update and Push are icons in the branch row. Three buttons never fit the
  panel width, so "Commit and Push" and "Push" overlapped.

## Phase 3 — Diff viewer

`lib/diff-parse.js` parses a unified diff into files → hunks → rows, and
`pairRows` aligns deletions against additions so a modified line shows both forms
on one row. The viewer renders a four column grid (old number, old code, new
number, new code) with per-line highlight.js, and toggles to unified.

Two bugs surfaced here:

- git quotes non-ASCII paths in `---`/`+++` headers exactly as it does in status.
  There is no `-z` for diff headers, so the parser unquotes octal escapes itself
  and `git-diff` also passes `-c core.quotePath=false`.
- `addTab` set `body: data.content` for new tabs, but diff tabs carry `body`.
  Every diff was blank the first time it was opened and only rendered on reopen.
  Pre-existing, unrelated to this work, fixed here.

## Phase 4 — Log / history

A third panel mode. `lib/git-graph.js` assigns commits to lanes: a lane waits for
a hash, the first parent inherits the lane so mainline stays straight, and extra
parents claim free lanes, which is what makes a merge fan out. Each row renders
an SVG with a curve per lane crossing and a dot (hollow for merges).

Clicking a commit expands the files it touched, and clicking a file opens that
commit's diff in the Phase 3 viewer. `show --name-status` needs `-m
--first-parent` or git prints nothing at all for a merge commit.

## Testing

The NUL parser is pure string handling and carries the highest risk, so it gets a
unit test over fixture output covering spaces, non-ASCII, renames, untracked
files, detached HEAD and ahead/behind.

Everything else is manual against a scratch repo: push on a new branch, staging a
non-ASCII filename, a partial commit, and amend.
