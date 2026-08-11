# Live reload of open files

Date: 2026-08-11
Status: implemented.

## Problem

Claude edits a file from the terminal while that same file sits open in the side
panel. The tab kept showing whatever was read when it was opened, so the panel
silently displayed stale content next to a terminal that had just changed it.

## Approach

Every tab on a real file registers a watch; a change re-reads the file and pushes
the new payload to the renderer.

`fs.watchFile` (stat polling, 400ms) rather than `fs.watch`. Tools frequently
write by replacing the inode, which silently kills an `fs.watch` handle and would
leave the tab stale again with no error. The polling cost for the handful of
files actually open is irrelevant.

Watches are reference counted by path, so the same file open in two sessions is
watched once and only released when the last tab on it closes. Tabs release on
close, and sessions release all their tabs on close.

Diff and welcome tabs are synthetic and never watched.

## Unsaved edits

The panel is editable, so a change on disk can collide with a change in the tab.

- **Tab is clean:** it takes the new content silently. This is the common case,
  and it is what the feature is for.
- **Tab is dirty:** the local edit is left exactly as it is, the tab is flagged
  stale, and a bar offers *Load from disk* or *Keep mine*. Nothing is overwritten
  without the user choosing.

## Not bouncing our own saves

`save-file` records the exact content it writes. When the watcher fires for that
path, a payload identical to what was just written is dropped rather than sent.
Otherwise every `⌘S` would round-trip back through the watcher and re-render the
tab the user was typing in.

## Scroll position

The viewer is rebuilt from scratch on each render, so an unattended reload would
throw the reader back to the top of a long file. The scroll offsets of the
scrolling element are captured before the re-render and restored after.

## Verification

Driven through the Chrome DevTools Protocol against the running app:

| Check | Result |
|---|---|
| external edit, clean tab | body and textarea both updated live |
| external edit, rendered markdown | rendered view showed the new text |
| external edit, dirty tab | local edit preserved, stale flag set, bar shown |
| *Load from disk* | disk content adopted, dirty cleared, bar removed |
| *Keep mine* | local edit kept, bar removed |
| Clide's own save | no stale flag, no bounce, body intact |
| background (inactive) tab | updated without being focused |
| closing a tab | tab removed and its watch released |
