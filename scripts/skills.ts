import { readFileSync, writeFileSync } from 'node:fs';
import { loadSkillIndex } from '../src/skills/loader.js';
import { scanSkills, formatScanReport, hasSeverityAtLeast } from '../src/skills/scanner.js';

const command = process.argv[2] ?? 'list';
const skillsDir = process.env.ARES_SKILLS_DIR ?? 'skills';

if (command === 'list') {
  const index = loadSkillIndex(skillsDir);
  for (const skill of index.all) console.log(`${skill.id}\t${skill.riskLevel}\t${skill.description}`);
} else if (command === 'audit') {
  const index = loadSkillIndex(skillsDir);
  const results = scanSkills(index.all);
  console.log(formatScanReport(results, process.cwd()));
  process.exitCode = hasSeverityAtLeast(results, 'high') ? 1 : 0;
} else if (command === 'validate') {
  const index = loadSkillIndex(skillsDir);
  console.log(`Loaded ${index.size} enabled skills from ${skillsDir}`);
} else if (command === 'enable' || command === 'disable') {
  const id = process.argv[3];
  if (!id) throw new Error(`Usage: npm run skills:${command} -- <skill-id-or-name>`);
  const skill = loadSkillIndex(skillsDir).get(id);
  if (!skill) throw new Error(`Skill not found: ${id}`);
  const path = `${skill.dir}/metadata.json`;
  const metadata = readMetadata(path);
  metadata.enabled = command === 'enable';
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(`${command === 'enable' ? 'Enabled' : 'Disabled'} ${skill.id}`);
} else {
  throw new Error(`Unknown skills command: ${command}`);
}

function readMetadata(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
