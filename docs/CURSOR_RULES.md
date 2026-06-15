# Cursor Rules

A small set of agent personas are mirrored as Cursor rules in
[`.cursor/rules/*.mdc`](../.cursor/rules) so you can pull a specialist into a Cursor
session. They're intentionally short and **manually referenced** (`alwaysApply:
false`) — they don't auto-attach and won't slow the project down.

## Available rules

| Reference | Persona |
|-----------|---------|
| `@agent-frontend-developer` | implement/improve UI in code |
| `@agent-security-engineer` | review a flow/code for vulnerabilities |
| `@agent-product-manager` | turn an idea into a buildable spec |
| `@agent-reality-checker` | pressure-test a plan / production readiness |
| `@agent-code-reviewer` | review a diff/PR for bugs and simplifications |

## Usage

```
Use @agent-security-engineer to review this authentication flow.
Use @agent-frontend-developer to improve this dashboard.
Use @agent-reality-checker to check if this feature is production-ready.
```

## Keeping them in sync

Each `.mdc` is a condensed version of the full persona in `agents/<category>/<id>/agent.md`
(linked at the bottom of each rule). When you change a persona's core behavior, update
the matching rule. Keep rules short — a few bullets. Add a new rule only for a persona
you actually reference in Cursor; don't mirror all 15.

> Why manual, not automatic? Auto-applied rules consume context on every request and
> can pull the wrong specialist into unrelated edits. Manual `@` references keep the
> specialist scoped to when you actually want it.
