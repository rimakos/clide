#!/bin/sh
# SessionStart drift check: warn if wiki files changed after the last log.md
# entry. That means a previous session ended without feeding the wiki.
# Convention: every wrap / ingest / goal writes log.md LAST, so anything newer
# than log.md is unlogged work.
#
# Assumes the wiki lives at "$CLAUDE_PROJECT_DIR/wiki". Change WIKI if you put
# it elsewhere.
WIKI="${CLAUDE_PROJECT_DIR:-.}/wiki"
[ -f "$WIKI/log.md" ] || exit 0
drift=$(find "$WIKI" -name "*.md" ! -name "log.md" ! -path "*/.obsidian/*" ! -path "*/.git/*" -newer "$WIKI/log.md" 2>/dev/null)
if [ -n "$drift" ]; then
  echo "MEMORY DRIFT (wiki): files modified after the last log.md entry. A previous session likely ended without logging. Review and run /wrap (or append log.md) before new work:"
  echo "$drift" | head -6
fi
exit 0
