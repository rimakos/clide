# Decisions (ADRs)

Compact architecture decision records, one file per non-obvious decision:
`NNNN-short-title.md`. Written by the `goal` skill at the END of a ticket — only
when the decision would surprise a future reader. Routine tickets are skipped.

Format (kept deliberately small):

```
---
tags: [decision]
date: YYYY-MM-DD
status: accepted
ticket: PROJ-1234
---
# NNNN — <title>

## Context
<what forced a choice; evidence-tagged>

## Decision
<what we chose>

## Consequences
<what this locks in / rules out; links to affected [[repos]] / [[seams]]>
```
