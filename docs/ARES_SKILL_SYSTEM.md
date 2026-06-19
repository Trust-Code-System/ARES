# ARES Skill System

ARES skills live in `skills/<group>/<skill>/` with `SKILL.md`, `metadata.json`, and optional `scripts/`, `references/`, `templates/`, `examples/`, and `tests/`.

The production-facing manifest is `SkillManifest` in `src/skills/manifest.ts`. `SkillLoader` reads manifests, `SkillValidator` checks required fields, `SkillSecurityScanner` audits content, `SkillRegistry` indexes enabled skills, and `SkillRouter` selects relevant skills without loading the full library into model context.

Imported skills are disabled by default. Enabling a skill requires passing audit and manual approval.
