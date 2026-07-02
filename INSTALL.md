# Installing Clide

macOS-only. You need **Node 18+** and the **`claude` CLI** already on your PATH.

## One command

```bash
git clone https://github.com/rimakos/clide.git
cd clide
./bin/install
```

That installs deps, rebuilds the native terminal module, puts `clide` on your PATH
(asks for sudo once), and installs the bundled **agentic-dev-os** skills into
`~/.claude/skills`.

Then run:

```bash
clide .                  # open the current folder
clide /path/to/repo
```

On your first launch Clide opens the agentic-dev-os map as the first tab.

## Manual steps (if you'd rather not run the script)

```bash
npm install
npm run rebuild                                   # native node-pty
sudo ln -sf "$PWD/bin/clide" /usr/local/bin/clide # launcher on PATH
npm run setup-os                                  # skills → ~/.claude/skills
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
