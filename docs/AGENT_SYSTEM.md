# Agent System

ARES has a **specialist-agent layer** that sits on top of the existing skill
system. It reuses the same machinery (markdown + metadata, lazy index, read-only
progressive-disclosure tools) rather than forking a parallel framework.

## What an agent is

A persona under `agents/<category>/<id>/`:

- `agent.md` — playbook (YAML frontmatter `name`/`description` + body sections:
  Identity, Role, When to use / not use, Responsibilities, Process, Output style,
  Deliverables, Safety rules, Examples).
- `metadata.json` — routing metadata: `id`, `name`, `category`, `description`,
  `source_repo`, `trigger_keywords`, `skills`, `tools`, `risk_level`, `enabled`.
- `examples.md` — example requests + output shapes.

Agents are **guidance, not authority**. A loaded persona never overrides ARES's
core rules or the safety gate. Irreversible tool calls are still gated at runtime
regardless of which persona is active.

## How it works

Three read-only tools (in [`src/agents/index.ts`](../src/agents/index.ts)):

| Tool | Purpose |
|------|---------|
| `find_agent` | search personas by keyword, returns ranked ids |
| `use_agent` | load one persona's full playbook to adopt for the task |
| `agent_route` | plan a (possibly multi-agent) response: intent, primary/supporting agents, skills, tools, model, risk, needs_confirmation |

The router ([`src/agents/router.ts`](../src/agents/router.ts)) is a **pure function**
(`selectAgents`) — deterministic, unit-tested, no model calls. It reuses the model
router's `selectRoute` for the provider decision, so model policy lives in one place.

Activation is **opt-in and on-demand**: the base system prompt only carries a
one-line pointer (`AGENTS_PROMPT_NOTE`). The model reaches for a specialist when a
task needs one; specialists are never all-on by default.

## Config

| Env | Default | Effect |
|-----|---------|--------|
| `ARES_AGENTS_ENABLED` | `true` | set `false` to unregister the agent tools |
| `ARES_AGENTS_DIR` | `./agents` | persona library location |

When `agentsDir` is set, `createDefaultRegistry` registers the three tools and the
system prompt gains the agent pointer — see [`src/index.ts`](../src/index.ts).

## Adding an agent

1. Create `agents/<category>/<id>/agent.md` + `metadata.json` (+ `examples.md`).
2. Keep `risk_level` honest — it drives the router's `needs_confirmation` and the
   tool's risk tag.
3. Vet it with the skill scanner's rule set ([`src/skills/scanner.ts`](../src/skills/scanner.ts) —
   `scanText`) before relying on it, then run the routing test (`tests/agentRouting.test.ts`).

## Provenance & safety

Persona structure and several roles are adapted from
[`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents) (MIT).
They were rewritten in ARES's house style and vetted with the existing skill safety
scanner before vendoring. See [`SAFETY_RULES.md`](./SAFETY_RULES.md).
