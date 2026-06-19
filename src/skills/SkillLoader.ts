import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SkillSecurityScanner } from '../security/SkillSecurityScanner.js';
import { SkillPermissionManager } from './SkillPermissionManager.js';
import { SkillValidator } from './SkillValidator.js';
import { SkillVersionManager } from './SkillVersionManager.js';
import type { LoadedSkill, SkillManifest } from './manifest.js';

export interface SkillLoaderOptions {
  rejectUnsafe?: boolean;
}

export class SkillLoader {
  constructor(
    private readonly skillsDir: string,
    private readonly validator = new SkillValidator(),
    private readonly security = new SkillSecurityScanner(),
    private readonly permissions = new SkillPermissionManager(),
    private readonly versions = new SkillVersionManager(),
  ) {}

  load(options: SkillLoaderOptions = {}): LoadedSkill[] {
    const root = path.resolve(this.skillsDir);
    if (!existsSync(root)) return [];
    const loaded: LoadedSkill[] = [];
    const seen = new Set<string>();
    for (const skillPath of walk(root).filter((file) => path.basename(file) === 'SKILL.md')) {
      const dir = path.dirname(skillPath);
      const metadataPath = path.join(dir, 'metadata.json');
      if (!existsSync(metadataPath)) continue;
      const manifest = this.validator.assert(JSON.parse(readFileSync(metadataPath, 'utf8'))) as SkillManifest;
      if (manifest.enabled === false) continue;
      if (seen.has(manifest.slug)) continue;
      seen.add(manifest.slug);

      const permissionDecision = this.permissions.evaluate(manifest);
      if (!permissionDecision.allowed) {
        if (options.rejectUnsafe ?? true) continue;
      }

      const scan = this.security.scanSkillDirectory(dir);
      if (!scan.passed && (options.rejectUnsafe ?? true)) continue;

      loaded.push({
        manifest,
        skillMarkdown: readFileSync(skillPath, 'utf8'),
        dir,
        metadataPath,
        skillPath,
        auditStatus: scan.passed ? 'passed' : 'failed',
        auditFindings: scan.findings,
      });
    }
    return this.versions.latest(loaded);
  }
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
