# ARES specialist-agent library

Expert **personas** the agent router activates on demand. Each persona lives in
`<category>/<id>/` with three files:

- `agent.md` — the playbook (YAML frontmatter `name`/`description` + body).
- `metadata.json` — routing metadata (triggers, skills, tools, risk, provenance).
- `examples.md` — example requests and the shape of good outputs.

These are **read-only guidance**, loaded via the `find_agent` / `use_agent` /
`agent_route` tools (see [`src/agents/`](../src/agents)). A persona never overrides
ARES's core rules or the safety gate — irreversible tool calls are still gated at
execution time regardless of which persona is active.

## Provenance

Persona structure and several role definitions are adapted from
[`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)
(MIT license). They were rewritten to fit ARES's house style and **scanned with the
existing skill safety scanner** (`npm run scan:skills` patterns) before vendoring.
`metadata.json` records `source_repo` for each.

## Categories

`engineering/` · `security/` · `testing/` · `product/` · `design/` · `ai/` ·
`strategy/` · `marketing/`

## Adding an agent

1. Create `agents/<category>/<id>/agent.md` + `metadata.json` (+ `examples.md`).
2. Keep `risk_level` honest — it drives the router's `needs_confirmation`.
3. Run the safety scan and the routing tests before relying on it.
