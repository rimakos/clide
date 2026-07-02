#!/bin/sh
# PreToolUse (Bash) git guardrail.
# Blocks irreversible git commands BEFORE they run. Exit 2 = block; the stderr
# message is fed back to the agent so it picks a safe alternative.
#
# Works whether git is called directly (`git ...`) or through a wrapper
# (`rtk git ...`, `rtk proxy git ...`) — the wrapper prefix is stripped before
# matching. Normal git (status/diff/add/commit/log, non-force push, branch
# checkout) passes straight through.

payload=$(cat)

# Only guard the Bash tool. Anything else: allow.
if command -v jq >/dev/null 2>&1; then
  tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
  cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
  [ -n "$tool" ] && [ "$tool" != "Bash" ] && exit 0
else
  cmd=$payload   # no jq: scan the whole payload (safe side: over-block, never under-block)
fi
[ -n "$cmd" ] || cmd=$payload

# Strip a leading wrapper (rtk / rtk proxy) so patterns match either form.
check=$(printf '%s' "$cmd" | sed -E 's/\brtk (proxy )?//g')

block() {
  echo "BLOCKED by git-guardrail: $1" >&2
  echo "Safe alternative: $2" >&2
  exit 2
}

# Each rule: a grep -E pattern on the normalized command.
if printf '%s' "$check" | grep -Eiq 'git[[:space:]]+push([[:space:]]+[^;&|]*)?[[:space:]]+(-f([[:space:]]|$)|--force([[:space:]]|$)|--force-with-lease)'; then
  block "git push --force overwrites remote history and can erase a teammate's commits." "push without --force; only force-with-lease after explicit team agreement"
fi
if printf '%s' "$check" | grep -Eiq 'git[[:space:]]+reset([[:space:]]+[^;&|]*)?[[:space:]]+--hard'; then
  block "git reset --hard permanently discards uncommitted work." "git stash, or git reset --soft, or commit first"
fi
if printf '%s' "$check" | grep -Eiq 'git[[:space:]]+clean([[:space:]]+[^;&|]*)?[[:space:]]+-[a-eg-z]*f'; then
  block "git clean -f deletes untracked files with no recovery." "git clean -n first to preview, then remove specific paths deliberately"
fi
# Case-SENSITIVE: -D force-deletes, -d safely refuses an unmerged branch.
if printf '%s' "$check" | grep -Eq 'git[[:space:]]+branch([[:space:]]+[^;&|]*)?[[:space:]]+-D'; then
  block "git branch -D force-deletes a branch even if unmerged." "git branch -d (lowercase) so an unmerged branch is refused, or confirm it is merged first"
fi
if printf '%s' "$check" | grep -Eiq 'git[[:space:]]+(checkout|restore)([[:space:]]+--)?[[:space:]]+\.([[:space:]]|$)'; then
  block "git checkout . / restore . wipes all local changes." "stash first (git stash), or revert only the specific files you mean to"
fi

exit 0
