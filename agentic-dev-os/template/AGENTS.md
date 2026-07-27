# Agent operating rules

Use the shared workspace wiki as durable memory. Before a substantial ticket,
inspect `wiki/index.md`, `wiki/system-map.md`, and the relevant repo/seam pages,
then run the `ticket-impact` skill when it applies.

- Keep changes scoped and preserve unrelated work.
- Use an isolated Git worktree for parallel tasks.
- Do not commit, push, merge, reset, or delete work unless the user explicitly asks.
- Publish cross-task findings through Clide coordination when `CLIDE_TASK_ID` is set.
- Verify the change before reporting completion.
- Finish a meaningful session with the `wrap` skill when it applies.

Provider-specific child agents or teams are optional. Use them only when the user
asks or the work naturally benefits from explicit parallel delegation.
