# ARES skill library

This directory is a **vendored** copy of expert-skill playbooks from:

- [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)
  (MIT License, © 2025 Alireza Rezvani) — the bulk of the library, in domain
  category directories.
- [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills)
  (MIT License, © 2025 Corey Haines) — 44 marketing skills, vendored under the
  `marketing-haines/` category to keep ids unique and provenance clear.

Each skill is a `SKILL.md` file with YAML frontmatter (`name`, `description`) and
a markdown playbook body, organized into domain category directories
(`engineering/`, `product-team/`, `finance/`, `research/`, …). Some skills also
bundle Python scripts alongside their `SKILL.md`.

## How ARES uses these

ARES discovers and uses them through two read-only tools (see
[`src/skills/`](../src/skills)):

- **`find_skill(query)`** — ranked keyword search over every skill's name +
  description. Keeps context lean: only relevant skills are surfaced, never the
  whole catalog.
- **`use_skill(id)`** — loads one skill's full playbook on demand. Skills are
  keyed by `id = <category>/<name>` because some names repeat across categories.

A skill's bundled Python scripts are **never run automatically**. `use_skill`
only reports their paths; they execute solely through the gated, audited
`run_python` tool — the same confirmation boundary as any other state-mutating
action.

## Provenance / updating

- Only the canonical category directories were vendored; the upstream repo's
  per-tool format copies (`.codex/`, `.gemini/`, `.claude-plugin/`, …) and
  conversion scaffolding were intentionally dropped.
- To disable the library entirely, set `ARES_SKILLS_ENABLED=false`. To point at a
  different location, set `ARES_SKILLS_DIR`.
- The bundled scripts are third-party code. Review a script before relying on it
  (the upstream project also ships a security auditor for this).
