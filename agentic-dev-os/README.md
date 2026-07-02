# agentic-dev-os

A portable agentic operating system for a multi-repo dev team, packaged as a Claude
Code plugin.

Every ticket runs the same loop: **scope the blast radius before planning, implement,
verify across repo boundaries, then feed what you learned into a shared knowledge
wiki** so the next ticket is cheaper. Config-driven and domain-agnostic. Point it at
your repos and go.

> New here? Open `docs/visualiser.html` in a browser for a one-page, clickable map of
> the whole flow. `docs/flow.md` is the written version.

## What's in the box

**The lifecycle skills** (the loop):

| Skill | Fires | Does |
|---|---|---|
| `ticket-impact` | before any plan or code | impact-aware pre-plan + Implementation Handoff; surfaces hidden scope and likely reviewer comments; Cross-repo mini-spec when a seam is touched |
| `cross-repo-review` | on a diff/PR | checks the diff against the stated invariant and system touch map |
| `pr-ticket-review` | on a PR | maps each ticket requirement to the diff (satisfied / partial / missing) + cross-repo ripple |
| `cross-repo-manual-test` | before QA | invariant-anchored manual test guide |
| `ticket-testing` | to verify behavior | drives the real app and reconciles every UI value against the read-only DB |
| `wrap` | end of every session | fixed closing checklist; files learnings to the wiki |
| `goal` | end of a ticket | compact ADR, only when a decision would surprise a future reader |

**Knowledge-wiki ops:**

| Skill | Does |
|---|---|
| `wiki-ingest` | file a new source into the wiki; update pages + index + log |
| `wiki-lint` | health check: contradictions, stale claims, orphans, missing evidence tags |
| `seed-test-data` | seed precondition rows in SQL so a tester lands at the test point |

**Extend the OS:**

| Skill | Does |
|---|---|
| `skill-workshop` | design + build a new skill (proposal first, then SKILL.md) |
| `mcp-impact` | decide if a branch warrants MCP tooling; reuse-first, safety-gated |

**The knowledge wiki** (`template/`): an LLM-maintained knowledge base. index, log,
system-map, per-repo and per-seam pages, decisions (ADRs), features. Every claim
carries an evidence tag (✅ confirmed / 🟡 inferred / ⬜ unknown).

## Install

**As a Claude Code plugin (recommended).** Push this folder to a Git repo, then in
Claude Code:

```
/plugin marketplace add your-org/agentic-dev-os
/plugin install agentic-dev-os
```

The skills become available as `/ticket-impact`, `/wrap`, etc. across your sessions.

**Or copy the skills manually.** Drop `skills/*` into your `~/.claude/skills/` (user
level) or a repo's `.claude/skills/` (project level).

## Set up the workspace (one time)

The `template/` folder is a working skeleton. Copy its contents into your
workspace root (the folder that holds your repo checkouts):

```
your-workspace/
├── CLAUDE.md          <- entry point Claude loads every session (wires the wiki + rules)
├── os-config.yaml     <- the one file you fill in
├── wiki/              <- the knowledge base (schema, index, log, system-map, templates)
└── .claude/
    ├── settings.json  <- registers the SessionStart + PreToolUse hooks
    └── hooks/
        ├── drift-check.sh          SessionStart: warns if a session skipped /wrap
        └── block-dangerous-git.sh  PreToolUse: blocks irreversible git before it runs
```

1. **Fill in `os-config.yaml`** — your repos, seams (integration boundaries),
   ticket source, conventions. This is what the skills read instead of hardcoding
   your topology. Delete the example entries.
2. **Seed `wiki/system-map.md` and `wiki/index.md`** from your config (list your
   repos and seams). The skills grow the rest as you work.
3. **Keep `CLAUDE.md` at the root.** It wires `@wiki/CLAUDE.md`, sets the ticket
   entry routine (read the wiki, run `/ticket-impact`, end with `/wrap`), and states
   the operating rules the flow assumes (never commit, subagent-driven execution,
   surgical changes, verify before done).
4. **Keep `.claude/`.** Two hooks:
   - `drift-check.sh` (SessionStart) warns the next session when a previous one
     changed the wiki but skipped `/wrap` (detected by files newer than `log.md`,
     since `wrap`/`ingest`/`goal` always write `log.md` last). Keeps the compounding
     loop honest. Assumes the wiki is at `wiki/`; edit `WIKI=` if you moved it.
   - `block-dangerous-git.sh` (PreToolUse on Bash) blocks irreversible git
     (`push --force`, `reset --hard`, `clean -f`, `branch -D`, `checkout .` /
     `restore .`) before it runs, and tells the agent a safe alternative. Normal git
     passes through. Works with a `git` wrapper (e.g. `rtk git`) too.

That is the whole "OS": the skills provide the flow, `CLAUDE.md` + the hook make it
run automatically, and the wiki is the memory it writes to.

## Rough cost per ticket

The flow spends tokens. `docs/visualiser.html` ships an interactive estimator
(pick difficulty, quick vs deep, path, and model rate); the table below is a
snapshot at Opus 4.8 rates ($5 / $1M input, $25 / $1M output), assuming ~45% of
input is served from prompt cache.

| Ticket | Path | Mode | ~Input | ~Output | ~Cost |
|---|---|---|---|---|---|
| Trivial | quick | quick | 60k | 11k | ~$0.45 |
| Small | quick | quick | 100k | 19k | ~$0.75 |
| Medium | quick | quick | 170k | 31k | ~$1.30 |
| Medium | full | quick | 290k | 48k | ~$2.10 |
| Large | quick | quick | 305k | 56k | ~$2.30 |
| Large | full | deep | 1.1M | 138k | ~$6.70 |
| Cross-repo epic | full | deep | 1.8M | 230k | ~$11 |

**Quick vs deep.** Quick runs each skill as a single agent pass. Deep fans out to
parallel subagents and adds adversarial verification, multiplying input ~2.1× and
output ~1.6×, for higher confidence on cross-repo and high-blast-radius work.
**Quick path** = ticket-impact, plan, implement, cross-repo-review, wrap.
**Full path** adds pr-ticket-review, cross-repo-manual-test, ticket-testing, goal.

These are planning heuristics for a real multi-repo team, not a billing guarantee.
Measure your own runs with `count_tokens` and edit the base numbers in the
estimator (top of the `<script>` block in `visualiser.html`).

## Philosophy

- **Scope before you plan.** Wider-scope ripple should surface as a pre-plan, not as
  PR comments.
- **Evidence over assertion.** Every claim is tagged and rankable: production data >
  code (file:line) > docs. Negative grep is never proof.
- **The wiki is the memory.** Topology and gotchas live in one place, tagged and
  cross-linked, not in ten people's heads.
- **The agent never commits.** It scopes, implements, reviews, and captures. The
  human integrates.
- **Deterministic beats judgment.** Anything done the same way twice becomes a skill.

## Layout

```
.claude-plugin/     plugin + marketplace manifests
skills/             the genericized skill set (SKILL.md each)
template/           copy into your workspace root
  CLAUDE.md         entry point: wires the wiki + operating rules
  os-config.yaml    <- fill this in
  .claude/          settings.json + hooks/drift-check.sh (SessionStart wrap-skipped warning)
  wiki/             CLAUDE.md schema + index/log/system-map + repo/seam templates
  decisions/        ADRs
docs/
  flow.md           the methodology in prose
  visualiser.html   clickable one-page flow map
```
