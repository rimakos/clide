---
name: skill-workshop
description: Use when the user wants to brainstorm, design, or create a new Claude Code skill from a rough idea. Runs a two-phase workflow: first a compact Skill Design Proposal, then the final SKILL.md only after approval. Applies cost-efficient exploration defaults: targeted context, no broad repo scans, cost-efficient output, and one-question-at-a-time design. Triggers on /skill-workshop, "create a skill", "build a skill", "design a skill", "brainstorm a skill", "I want a skill that...", "help me make a skill", "new skill for...".
---

# skill-workshop

## Purpose

Help the user turn a rough skill idea into a working Claude Code skill without requiring them to know prompt-engineering, frontmatter conventions, or skill-design tradeoffs upfront.

The user describes what they want. This skill drives the design conversation, applies good defaults, and produces the final `SKILL.md` only after the design is clear.

## When to use

Use this skill when the user says things like:

- `/skill-workshop`
- "create a skill"
- "build a skill"
- "design a skill"
- "brainstorm a skill"
- "I want a skill that..."
- "help me make a skill"
- "new skill for..."

If the user gives a rough idea like "I want a skill for PR comments" or "I want a skill to generate manual tests", start the workflow with that rough idea as input.

## Hard rule: two phases

Phase 1: Brainstorm and produce a compact **Skill Design Proposal** in chat.

Phase 2: After the user approves the proposal, write the final `SKILL.md`.

Never skip Phase 1. Even when the request seems specific, produce the proposal first because it surfaces decisions the user may not know to define.

## Default decisions

Use these defaults unless the user explicitly asks otherwise:

- Location: personal skill in `~/.claude/skills/<skill-name>/`
- Trigger: slash command plus natural-language trigger phrases
- Workflow shape:
    1. Skill Design Proposal
    2. Final `SKILL.md` after approval
- Scope: single-purpose by default
- Output: chat output during Phase 1, file write only during Phase 2
- Stop condition: stop after producing the intended output
- Tool composition: optional, never automatic unless clearly useful
- Deep analysis or Explore agent: never automatic
- Repo search: targeted context only
- Existing skills: list names first, read only related `SKILL.md` files
- Project context: read nearest `CLAUDE.md` first, read more only if needed
- External docs or Context7: only when the skill targets a specific library, framework, SDK, or API
- PR/link fetching: opt-in only
- Model routing: use the highest-reasoning model for skill design, and a standard model for writing/editing once the design is confirmed
- Handoff: include an Implementation Handoff only when another model, session, or skill will continue
- Cost estimate: include rough token/cost estimate only when the user asks or when the proposed skill is likely to be expensive

Do not ask the user to choose defaults that are already defined above. Ask only when the request conflicts with a default or when multiple choices materially change the skill.

## Workflow

### Phase 1: Design

Run these steps in order. Ask one question at a time only when a decision is genuinely needed. Prefer multiple-choice over open-ended questions.

If the answer is obvious from the user's request, infer it and proceed.

1. **Understand the rough idea**
    - Restate the skill idea in one sentence.
    - Identify the real problem it solves, not just the surface request.
    - Decide whether it is narrow enough to be a good skill.

2. **Gather lightweight context**
    - Read the nearest `CLAUDE.md` first if it is relevant and not already in context.
    - Only read parent `CLAUDE.md` files if the nearest one is missing or clearly incomplete.
    - List existing skill names from `~/.claude/skills/` and `.claude/skills/`.
    - Read only related `SKILL.md` files by name, trigger, or workflow similarity.
    - Do not broad-scan the repo.
    - Do not read unrelated files.

3. **Decide skill shape**
   Use the default decisions unless the user's request requires otherwise.

   Define:
    - Skill name
    - Location
    - Trigger style
    - Whether it is single-purpose or composed with another skill
    - Required inputs
    - Optional inputs
    - Main output
    - Stop condition
    - Handoff behavior, if needed

4. **Compose with existing tools only when useful**
   Use or reference these only when they add value:

    - `superpowers:brainstorming`: when the skill idea is vague and needs structured discovery
    - `superpowers:writing-skills`: for stricter final `SKILL.md` authoring if useful
    - `context7`: when the skill targets a specific library, framework, SDK, or API and needs current docs
    - Existing project skills: when the new skill should hand off to or avoid duplicating them

5. **Apply cost-efficiency defaults**
   Always apply these silently:

    - Targeted context reads only
    - No full-file dumps
    - No repo-wide scans
    - No automatic Explore-agent dispatch
    - No automatic PR/link/doc fetch
    - Hard output limits
    - Empty sections omitted
    - Internal checklists kept internal unless load-bearing
    - Stop after the intended output
    - No automatic chaining into another skill

6. **Emit the Skill Design Proposal**
   Use the template below.
   Stop after the proposal and wait for approval.

### Phase 2: Write the final SKILL.md

Only run after the user approves the proposal with wording like:

- "looks good"
- "go ahead"
- "create it"
- "write the skill"
- "make the SKILL.md"

Steps:

1. Confirm the target path only if it is unclear.
    - Default: `~/.claude/skills/<skill-name>/SKILL.md`

2. If the skill targets a specific library, framework, SDK, or API, optionally use `context7` for current examples.

3. Write the final `SKILL.md` using the structure below.

4. Stop after writing the file.

Do not create supporting files such as `scripts/`, `references/`, examples, or helper docs unless the user explicitly asks.

## Skill Design Proposal output template

```markdown
# Skill Design Proposal

## Skill name
<kebab-case>

## Problem it solves
<one or two sentences>

## Trigger
- Slash command: <yes/no, command name>
- Natural language: <trigger phrases>

## Inputs
**Required**:
- <minimum input>

**Optional**:
- <optional context>

## Workflow
1. <step>
2. <step>
3. <step>

## Output
<what the skill emits>

## Tool / skill composition
- <tool or skill>: <when and why>

## Stop condition
<where the skill stops>

## Cost-control behavior
Uses default cost-efficient behavior: targeted context only, no broad scans, no automatic deep pass, hard output limits, empty sections omitted.

## Open decisions
- <only include if genuinely needed>
```

## Skill Design Proposal hard limits

- Max 7 workflow steps
- Max 6 trigger phrases
- Max 5 total input bullets
- Max 4 open decisions
- No large example output dumps
- No anti-patterns table in the proposal
- Omit empty sections

## Final SKILL.md structure

When writing the actual skill file in Phase 2, include:

```markdown
---
name: <kebab-case>
description: <one paragraph. Include when to use it and trigger phrases.>
---

# <skill-name>

## Purpose
<1 to 2 sentences>

## When to use
<slash command plus natural-language triggers>

## Inputs
<required and optional inputs>

## Workflow
<numbered steps with cost-efficiency rules baked in>

## Output template
<exact output skeleton>

## Hard rules
<non-negotiables, especially stop conditions and no auto-invoke behavior>

## Anti-patterns
<small don't/do table>

## Example usage
<short scenario only if it improves trigger or output clarity>
```

## Hard rules

- Two phases, always. Proposal first, `SKILL.md` second.
- Never write the final skill from a one-line request without a proposal.
- Do not ask the user about defaults already defined in this file.
- Ask only one question at a time.
- Prefer multiple-choice questions when the user must decide.
- Do not broad-scan the repo.
- Read existing skills by name first. Read only related skill files.
- Read the nearest `CLAUDE.md` first. Read more only if needed.
- Do not auto-dispatch Explore agents.
- Do not auto-fetch PR links, external links, or docs unless the user asks or the skill target requires current documentation.
- Do not auto-chain into another skill.
- Stop after Phase 1 output.
- Stop after Phase 2 file write.
- Do not create supporting files unless explicitly requested.
- Keep cost-efficiency behavior silent unless the user asks about cost.

## Anti-patterns

| Don't | Do |
|---|---|
| Write `SKILL.md` straight from a rough one-liner | Produce a Skill Design Proposal first |
| Ask many setup questions at once | Ask one question at a time |
| Ask the user to decide obvious defaults | Apply the default decisions silently |
| Broad-scan the repo for context | Read nearest `CLAUDE.md` and related skills only |
| Read all existing skill files | List skill names first, then read only related ones |
| Re-explain cost-efficiency every time | Apply it silently |
| Render empty proposal sections | Omit them |
| Auto-invoke `superpowers:writing-skills` | Use it only when it adds value |
| Pull Context7 docs for every skill | Use Context7 only for library/framework/API-specific skills |
| Generate an Explore agent for thoroughness | Mark deep pass recommended, but do not run it automatically |
| Create helper files by default | Create only `SKILL.md` unless asked |

## Example usage

User:

```text
/skill-workshop I want a skill that helps me write release notes from merged PRs.
```

Skill response starts with the design phase:

```markdown
# Skill Design Proposal

## Skill name
release-notes

## Problem it solves
Turn merged PRs into compact release notes without manually rereading every PR.

## Trigger
- Slash command: /release-notes
- Natural language: "draft release notes", "release notes from PRs"

## Inputs
**Required**:
- PR list or date range

**Optional**:
- Target audience
- Component grouping preference

## Workflow
1. Parse PR list or date range.
2. Fetch PR titles and bodies only if explicitly requested.
3. Group changes by component or label.
4. Draft concise release notes.
5. Emit final markdown.

## Output
Compact markdown release notes. Max 8 grouped sections. No raw PR dumps.

## Tool / skill composition
- gh CLI: only when the user asks to fetch PRs.

## Stop condition
Stops after release notes markdown is emitted.

## Cost-control behavior
Uses defaults. No PR diff fetch by default.
```

Then the skill stops.

If the user says:

```text
looks good, create it
```

The skill writes:

```text
~/.claude/skills/release-notes/SKILL.md
```

Then stops.
