# Importing Skills

Use:

```bash
npm run skills:import -- https://github.com/org/repo
npm run skills:audit
npm run skills:list
npm run skills:enable -- imported/skill-id
```

The importer clones into a temp directory, detects `SKILL.md`, scans markdown/metadata/scripts, converts passing skills into ARES metadata, writes them under `skills/imported/`, and keeps them disabled. It never executes imported scripts.
