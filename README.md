# Clide — Claude terminal IDE

Two-pane macOS app: a real terminal running `claude` on the left, a typed
side-panel viewer on the right. When Claude runs `open <file>`, the file shows
up in a tab rendered by type (email/text editable, markdown rendered⇄raw, code,
image) with a clean **Copy** button so you paste in the right format instead of
fighting terminal copy-paste.

## Bundled agentic-dev-os

Clide ships the **agentic-dev-os** — a portable, multi-repo agentic workflow packaged
as a Claude Code plugin (lifecycle skills + a knowledge wiki). It lives in
[`agentic-dev-os/`](agentic-dev-os/) — see its [README](agentic-dev-os/README.md).
On your first launch, Clide opens its clickable map
([`agentic-dev-os/docs/visualiser.html`](agentic-dev-os/docs/visualiser.html)) as the
first tab so you can see the whole flow, the skills, and what fires when.

It's **optional** — Clide works fully without it. The Welcome tab has a one-click
**Install** button; or run `npm run setup-os` (or `./bin/install --with-os`). All copy
the skills into `~/.claude/skills`. Not interested? Ignore it — nothing touches your
Claude config unless you ask.

> Browse the map on GitHub:
> [github.com/rimakos/clide/blob/main/agentic-dev-os/docs/visualiser.html](https://github.com/rimakos/clide/blob/main/agentic-dev-os/docs/visualiser.html)
> — or clone and open it in a browser for the interactive version.

## Install (first time)

macOS, Node 18+, and the `claude` CLI on your PATH. One command:

```bash
git clone https://github.com/rimakos/clide.git
cd clide
./bin/install
```

Full steps, manual install, update, and troubleshooting: see [INSTALL.md](INSTALL.md).

## Run

```bash
clide .                  # open current folder
clide ~/some/repo
```

Or run directly without installing the launcher:

```bash
CLIDE_CWD=/path/to/repo npx electron .
```

## How it works

The terminal launches `claude` with `PATH` prepended by `shim/open`. That shim
catches any `open` Claude runs, resolves the path, and tells the app to open a
tab. URLs and missing files fall through to the real `/usr/bin/open`, so browser
links still work. Nothing reaches the real TextEdit.

## Viewers

| File | Viewer | Copy |
|---|---|---|
| `.txt`, `.eml`, none | editable mono text | raw text |
| `.md` | Rendered ⇄ Raw toggle | rich HTML or raw source |
| code (`.js .ts .py .json …`) | editable mono | exact code |
| images (`.png .jpg .svg …`) | preview | copy image / reveal in Finder |

`⌘S` saves edits back to the file (asks once before the first overwrite).

## Config

- `CLIDE_PORT` (default `8771`) — localhost port the shim talks to.
- `CLIDE_CWD` — folder to open (set by the `clide` launcher).
