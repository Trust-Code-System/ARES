# Skill Import Audit

Generated on 2026-06-19 from static clones in `%TEMP%/ares-skill-repo-audit`. No third-party script was executed.

## Repository Findings

| Repo | Purpose | Static inventory | ARES decision |
| --- | --- | ---: | --- |
| anthropics/skills | Official Agent Skills examples and API-focused skills | 18 SKILL.md, 94 markdown, 75 scripts | Reusable format, progressive disclosure, references/scripts layout. Import only through audit. |
| anthropics/prompt-eng-interactive-tutorial | Prompt engineering lessons and notebooks | 0 SKILL.md, 3 markdown, 3 scripts/notebooks | Adapt prompt rules into ARES prompting docs and prompt builder. Do not import as skills. |
| alirezarezvani/claude-skills | Large multi-agent skill library | 763 SKILL.md, 2572 markdown, 620 scripts | Useful category coverage. High duplicate/supply-chain risk; import gradually, disabled by default. |
| muratcankoylan/Agent-Skills-for-Context-Engineering | Context engineering and multi-agent architecture | 21 SKILL.md, 153 markdown, 72 scripts | Adapt context budget, handoff, research-loop patterns. Audit scripts before use. |
| addyosmani/agent-skills | Production engineering workflows and verification gates | 24 SKILL.md, 60 markdown, 9 scripts | Adapt engineering workflows, anti-rationalization checks, verification gates. |
| msitarzewski/agency-agents | Specialist agent personas | 0 SKILL.md, 275 markdown, 7 scripts | Adapt persona structure into internal agents. |
| ruvnet/ruflo | Agent runtime/workflow system | 336 SKILL.md, 1692 markdown, 2227 scripts | Too large for direct import. Extract architecture ideas only after targeted audit. |
| anthropics/knowledge-work-plugins | Knowledge-work plugins and domain packs | 212 SKILL.md, 1026 markdown, 26 scripts | Useful enterprise/domain workflows; disabled import only. |
| VoltAgent/awesome-agent-skills | Curated index of skills | 0 SKILL.md, 2 markdown | Research directory only. Do not import listings as executable skills. |
| travisvn/awesome-claude-skills | Curated Claude skill list and best practices | 0 SKILL.md, 2 markdown | Adapt progressive-disclosure guidance only. |
| heilcheng/awesome-agent-skills | Multilingual curated skill index | 0 SKILL.md, 8 markdown, 4 scripts | Research directory only. |
| debs-obrien/learn-agent-skills | Learning material for creating skills | 2 SKILL.md, 14 markdown, 1 script | Adapt authoring guidance; import example skills only if needed. |

## Imported Skills

None from third-party repos were enabled automatically. The new importer writes passing skills to `skills/imported/` with `enabled: false`.

## Adapted Skills

ARES-owned seeds were created under `skills/ares-core/` for core reasoning, coding, context engineering, documents, browser/computer control, communication, research, business, design, safety/permissions, and project-specific workflows.

## Rejected Skills

Bulk direct import was rejected. Large repositories contain scripts, broad tool assumptions, duplicate skills, prompt-like instructions, network access, and secret-related examples that require per-skill audit.

## Security Concerns

Third-party skills are untrusted. The scanner flags prompt injection, hidden instructions, dangerous shell, network access, environment/secret access, suspicious encoded payloads, destructive operations, git history rewriting, production changes, and credential-store access.

## License Concerns

Every adapted or imported skill must retain `source_repo`, `adapted_from`, and `license_notes`. The importer marks license status as requiring review.

## Duplicates Merged

Registry deduplication is slug-based. The version manager keeps the latest semver manifest for a duplicate slug.

## Final Skill List

Run `npm run skills:list` for the current enabled skill catalog.
