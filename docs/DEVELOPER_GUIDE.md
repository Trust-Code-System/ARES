# Developer Guide

Seed ARES-owned skills:

```bash
npm run skills:seed
```

Validate and audit:

```bash
npm run skills:validate
npm run skills:audit
npm run typecheck
npm test
```

Create a skill by adding `SKILL.md` and `metadata.json` under `skills/<group>/<slug>/`. Keep permissions minimal, include source/license notes, and add verification steps.
