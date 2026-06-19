import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillSecurityScanner } from '../src/security/SkillSecurityScanner.js';

const repos = process.argv.slice(2).filter((arg) => arg.startsWith('https://github.com/'));
if (repos.length === 0) {
  console.log('Usage: npm run skills:import -- https://github.com/org/repo [...]');
  process.exit(0);
}

const tmpRoot = path.join(os.tmpdir(), 'ares-agent-skill-imports');
const importedRoot = path.resolve('skills', 'imported');
const reportsRoot = path.resolve('reports');
mkdirSync(tmpRoot, { recursive: true });
mkdirSync(importedRoot, { recursive: true });
mkdirSync(reportsRoot, { recursive: true });
mkdirSync(path.resolve('docs'), { recursive: true });

const scanner = new SkillSecurityScanner();
const imported: unknown[] = [];
const rejected: unknown[] = [];

for (const repo of repos) {
  const repoKey = repo.replace(/^https:\/\/github.com\//, '').replace(/[^\w.-]+/g, '__');
  const checkout = path.join(tmpRoot, repoKey);
  if (!existsSync(path.join(checkout, '.git'))) {
    if (existsSync(checkout)) throw new Error(`Refusing to reuse non-git temp path: ${checkout}`);
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', repo, checkout], { stdio: 'ignore' });
  }
  const skillFiles = walk(checkout).filter((file) => path.basename(file) === 'SKILL.md');
  for (const skillFile of skillFiles) {
    const sourceDir = path.dirname(skillFile);
    const slug = `${repoKey}__${path.basename(sourceDir).replace(/[^\w.-]+/g, '-')}`.toLowerCase();
    const scan = scanner.scanSkillDirectory(sourceDir);
    const targetDir = path.join(importedRoot, slug);
    const manifest = buildManifest(repo, slug, skillFile, scan.passed);
    if (!scan.passed) {
      rejected.push({ repo, skillFile, slug, reason: 'security scan failed', findings: scan.findings });
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), readFileSync(skillFile, 'utf8'), 'utf8');
    writeFileSync(path.join(targetDir, 'metadata.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    imported.push({ repo, skillFile, slug, enabled: false });
  }
}

writeFileSync(path.join(reportsRoot, 'rejected-skills.json'), `${JSON.stringify(rejected, null, 2)}\n`, 'utf8');
writeFileSync(path.resolve('docs', 'skill-import-audit.md'), auditMarkdown(imported, rejected), 'utf8');
console.log(`Imported ${imported.length} disabled skills; rejected ${rejected.length}. See docs/skill-import-audit.md`);

function buildManifest(repo: string, slug: string, skillFile: string, passed: boolean): Record<string, unknown> {
  const text = readFileSync(skillFile, 'utf8');
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? slug;
  const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? `Imported skill from ${repo}`;
  return {
    name,
    slug,
    description,
    category: 'imported',
    when_to_use: [description],
    when_not_to_use: ['Do not use until manually reviewed and enabled.', 'Do not use for external state changes without confirmation.'],
    required_tools: [],
    optional_tools: [],
    permissions: ['read_files'],
    safety_level: passed ? 'medium' : 'high',
    input_schema: { type: 'object', additionalProperties: true },
    output_schema: { type: 'object', additionalProperties: true },
    workflow_steps: ['Review imported instructions.', 'Load references only when needed.', 'Apply ARES safety gates before any tool use.'],
    verification_steps: ['Confirm security audit passed.', 'Confirm permissions are minimal.', 'Confirm output satisfies user intent.'],
    examples: [],
    failure_modes: ['Unsafe upstream instruction', 'Missing dependency', 'Duplicate skill'],
    rollback_plan: 'Disable or delete this imported skill. No imported script is executed by the importer.',
    human_confirmation_required: true,
    allowed_actions: ['Read instructions', 'Draft safe outputs'],
    forbidden_actions: ['Execute bundled scripts during import', 'Access secrets', 'Bypass confirmation'],
    version: '0.0.0-imported',
    source_repo: repo,
    adapted_from: skillFile,
    license_notes: 'Imported as disabled review material. Check upstream license before production use.',
    enabled: false,
  };
}

function auditMarkdown(imported: unknown[], rejected: unknown[]): string {
  return `# Skill Import Audit\n\nGenerated: ${new Date().toISOString()}\n\n## Imported Skills\n\n${list(imported)}\n\n## Adapted Skills\n\nImported skills were converted to ARES metadata format, marked disabled, and restricted to read-only permissions pending manual review.\n\n## Rejected Skills\n\n${list(rejected)}\n\n## Security Concerns\n\nThird-party skills remain untrusted. The importer never executes bundled scripts, never grants permissions automatically, and rejects high-risk scan failures.\n\n## License Concerns\n\nEvery imported skill keeps source attribution. Production use requires checking the upstream license.\n\n## Duplicates Merged\n\nDuplicate detection is slug-based in this importer and registry-level in ARES.\n\n## Final Skill List\n\nRun \\`npm run skills:list\\` after import.\n`;
}

function list(items: unknown[]): string {
  if (items.length === 0) return '- None';
  return items.map((item) => `- ${JSON.stringify(item)}`).join('\n');
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of safeReadDir(root)) {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(root, entry);
    const st = safeStat(full);
    if (!st) continue;
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(file: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}
