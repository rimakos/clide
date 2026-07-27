# Installing Clide

macOS-only. You need **Node 22.12+** and at least one of **Claude Code** (`claude`) or
**Codex** (`codex`) on your PATH. Install both to mix providers in one Clide window.

## One command

```bash
git clone https://github.com/rimakos/clide.git
cd clide
./bin/install
```

That installs deps, rebuilds the native terminal module, and puts `clide` on your PATH
(asks for sudo once). Clide works fully on its own — the bundled agentic-dev-os is
**not** installed by default.

Then run:

```bash
clide .                  # open the current folder
clide /path/to/repo
```

On your first launch Clide opens the agentic-dev-os map as a tab so you know it's
there. Close it and ignore it if you just want the editor.

## Optional: the agentic-dev-os skills

Want the bundled workflow skills (`/ticket-impact`, `/wrap`, `/goal`, …) in your
Claude and Codex sessions? Three ways:

- **Click Install** on the Welcome tab that opens on first launch — one button, done.
- `npm run setup-os` (add `--force` to overwrite skills you already have).
- `./bin/install --with-os` to bundle it into the first install.

All three copy the canonical skills into `~/.claude/skills` and `~/.agents/skills`.
Restart the provider CLI to load them.

Not interested? Do nothing — Clide never touches either skills directory unless you
run this.

## Manual steps (if you'd rather not run the script)

```bash
npm install
npm run rebuild                                   # native node-pty
sudo ln -sf "$PWD/bin/clide" /usr/local/bin/clide # launcher on PATH
npm run setup-os                                  # OPTIONAL: skills → both providers
```

## Update

Signed builds check the GitHub release feed in-app. The **Update** button downloads
only a published signed artifact; the previous version is recorded so its installer
can be selected from GitHub Releases if a rollback is needed.

Source installs update with:

```bash
git pull
npm install && npm run rebuild
npm run setup-os -- --force                       # refresh bundled skills
```

Use **Backup** in the task rail before moving machines. The exported JSON includes
workspaces, tasks, layouts, coordination artifacts, and local metric counters, but no
provider credentials or transcript contents.

## Uninstall

```bash
sudo rm /usr/local/bin/clide
# optional skills live in ~/.claude/skills and ~/.agents/skills
# local Clide task/worktree metadata lives in ~/.clide (remove it only if unwanted)
```

## Troubleshooting

- **`clide: command not found`** — the launcher symlink didn't land. Re-run the
  `ln -sf …` line, or check `/usr/local/bin` is on your `$PATH`.
- **Terminal pane blank / node-pty error** — run `npm run rebuild` (the native
  module must be built for your machine + Electron version).
- **Claude/Codex not found inside Clide** — install the relevant CLI and make sure it
  is on the PATH your login shell uses. Clide disables unavailable provider buttons.
- **Unsure what is missing** — run `npm run doctor`, or click **Doctor** in the task
  rail. It checks Git, both providers, node-pty, skills, and local state.
