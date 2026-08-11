# Terminal panes — up to four resizable splits

Date: 2026-08-11
Status: implemented.

## Problem

Sessions already existed as top tabs, but only the active one was displayed:
`switchSession` set `display:block` on one `.term` and `none` on the rest. There
was no way to watch two agents at once.

## Model

`#terminals` renders a recursive layout tree.

```
leaf   { type:'leaf',  key }
split  { type:'split', dir:'h'|'v', a, b, ratio }
```

Each leaf reparents that session's existing `termEl`, so xterm instances and
their scrollback survive every relayout. Sessions not currently in a pane move to
a hidden `#term-parking` div and keep running; they stay reachable from the tabs.

`dir` is `'h'`/`'v'`, not `'row'`/`'col'`, because `style.css` already owns a
`.row` utility for file tree rows (`height:24px; align-items:center`). A
`.pane-split.row` inherited that height and collapsed every pane to 24px tall.

The root node is absolutely positioned to fill `#terminals`. Relying on flex
stretch there left it at content height.

`panes.js` is wrapped in an IIFE and exports only `window.Panes`. Classic scripts
share one realm, and an earlier module leaked a `buildTree` that silently replaced
the file explorer's own.

## Behaviour

- Max four panes. At the cap the split action toasts and creates nothing.
- Splitting spawns a new claude session in the same folder and adds a tab, like
  iTerm and VS Code.
- `⌘D` splits right, `⇧⌘D` splits down.
- Every divider drags, clamped to a 15/85 ratio so neither half becomes unusable.
- Clicking a pane focuses it. `activeKey` now means *focused pane*, so the
  viewer, git panel cwd and status bar follow it with no changes to any of them.
- Closing a session drops its leaf and promotes its sibling into the parent's
  place, so there are never empty panes.

## Sizing

`fitActive()` now fits every session mounted in `#terminals` and sends
`session-resize` per pane, instead of only the focused one. All existing call
sites (window resize, divider drags, explorer toggle) keep working unchanged.

## Verification

Driven through the Chrome DevTools Protocol against the running app:

| Check | Result |
|---|---|
| split right, then down | 1 → 2 → 3 panes, dividers 0 → 1 → 2 |
| fourth split | 4 panes, 3 dividers |
| fifth split at cap | no new pane, no new session |
| pane geometry | 382x778 beside two 382x387, terminals 39 rows vs 19 |
| divider drag | widths 382,382,382 → 501,501,262; cols followed to 62,31,62 |
| close focused session | 3 panes → 2, dividers 2 → 1, no orphaned terminals |
