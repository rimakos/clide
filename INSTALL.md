# Installing Clide

macOS-only. You need **Node 18+** and the **`claude` CLI** already on your PATH.

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
Claude sessions? Install them into `~/.claude/skills`:

```bash
npm run setup-os                 # add --force to overwrite skills you already have
# or bundle it into the first install:  ./bin/install --with-os
```

Not interested? Do nothing — Clide never touches `~/.claude/skills` unless you run
this.

## Manual steps (if you'd rather not run the script)

```bash
npm install
npm run rebuild                                   # native node-pty
sudo ln -sf "$PWD/bin/clide" /usr/local/bin/clide # launcher on PATH
npm run setup-os                                  # OPTIONAL: skills → ~/.claude/skills
```

## Update

```bash
git pull
npm install && npm run rebuild
npm run setup-os -- --force                       # refresh bundled skills
```

## Uninstall

```bash
sudo rm /usr/local/bin/clide
# skills you installed live in ~/.claude/skills/ — delete the ones you don't want
```

## Troubleshooting

- **`clide: command not found`** — the launcher symlink didn't land. Re-run the
  `ln -sf …` line, or check `/usr/local/bin` is on your `$PATH`.
- **Terminal pane blank / node-pty error** — run `npm run rebuild` (the native
  module must be built for your machine + Electron version).
- **`claude` not found inside Clide** — install the Claude CLI and make sure it's on
  the PATH your login shell uses.
