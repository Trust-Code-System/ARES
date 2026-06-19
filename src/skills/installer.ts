/**
 * GitHub skill repository installer.
 *
 * Installs third-party skill packs into a managed area under ARES_SKILLS_DIR.
 * The installer never executes repository code. It clones files, indexes
 * SKILL.md records, runs the existing static scanner, and only then activates
 * the repo by moving it into place.
 */

import { mkdtemp, rm, rename, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../types.js';
import { loadSkillIndex } from './loader.js';
import { formatScanReport, hasSeverityAtLeast, scanSkills, type Severity } from './scanner.js';
import { INSTALLED_REPO_SEGMENTS } from './installPaths.js';

export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** Optional branch/tag/ref parsed from a /tree/... URL or supplied by caller. */
  ref?: string;
}

export interface InstalledSkillRepo {
  owner: string;
  repo: string;
  ref?: string;
  url: string;
  dir: string;
  skillsInstalled: number;
  scanReport: string;
  worstFinding?: Severity;
}

export type GitRunner = (args: readonly string[], opts: { cwd?: string; signal?: AbortSignal }) => Promise<void>;

export interface InstallSkillRepoOptions {
  skillsDir: string;
  url: string;
  ref?: string;
  overwrite?: boolean;
  /** Refuse activation when a scan finding reaches this severity. Default: critical. */
  blockSeverity?: Severity;
  logger?: Logger;
  signal?: AbortSignal;
  git?: GitRunner;
}

export async function installSkillRepo(opts: InstallSkillRepoOptions): Promise<InstalledSkillRepo> {
  const parsed = parseGithubRepoUrl(opts.url);
  const ref = opts.ref ?? parsed.ref;
  const skillsRoot = path.resolve(opts.skillsDir);
  const managedRoot = path.join(skillsRoot, ...INSTALLED_REPO_SEGMENTS);
  const target = path.join(managedRoot, parsed.owner, parsed.repo);
  const blockSeverity = opts.blockSeverity ?? 'critical';
  assertInside(managedRoot, target);

  const tempParent = await mkdtemp(path.join(os.tmpdir(), 'ares-skill-install-'));
  const tempRepo = path.join(tempParent, 'repo');

  try {
    await cloneRepo({
      repo: parsed,
      ref,
      target: tempRepo,
      git: opts.git ?? runGit,
      signal: opts.signal,
    });

    const previewIndex = loadSkillIndex(tempRepo, opts.logger);
    if (previewIndex.size === 0) {
      throw new Error('No SKILL.md files were found in that repository.');
    }

    const scanResults = scanSkills(previewIndex.all);
    const scanReport = formatScanReport(scanResults, tempRepo);
    if (hasSeverityAtLeast(scanResults, blockSeverity)) {
      throw new Error(
        `Skill repo scan found ${blockSeverity}+ findings; refusing to activate.\n${scanReport}`,
      );
    }

    await mkdir(path.dirname(target), { recursive: true });
    if (opts.overwrite ?? true) {
      await rm(target, { recursive: true, force: true });
    }
    await rename(tempRepo, target);

    const installedIndex = loadSkillIndexForInstalledRepo(skillsRoot, target, opts.logger);
    const worstFinding = scanResults
      .map((r) => r.worst)
      .filter((s): s is Severity => Boolean(s))
      .sort((a, b) => severityRank(b) - severityRank(a))[0];

    return {
      owner: parsed.owner,
      repo: parsed.repo,
      ...(ref ? { ref } : {}),
      url: normalizedGithubUrl(parsed),
      dir: target,
      skillsInstalled: installedIndex.size,
      scanReport,
      ...(worstFinding ? { worstFinding } : {}),
    };
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}

export function parseGithubRepoUrl(input: string): GithubRepoRef {
  const trimmed = input.trim();
  const normalized = trimmed.startsWith('github.com/') ? `https://${trimmed}` : trimmed;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Expected a GitHub repository URL such as https://github.com/owner/repo.');
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only https://github.com repository URLs are supported.');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('GitHub URL must include an owner and repository name.');
  }

  const owner = cleanGithubPathPart(parts[0] ?? '', 'owner');
  const repo = cleanGithubPathPart((parts[1] ?? '').replace(/\.git$/i, ''), 'repo');
  let ref: string | undefined;
  if (parts[2] === 'tree' && parts.length > 3) {
    ref = parts.slice(3).join('/');
  }
  return { owner, repo, ...(ref ? { ref } : {}) };
}

function loadSkillIndexForInstalledRepo(skillsRoot: string, repoRoot: string, logger?: Logger): ReturnType<typeof loadSkillIndex> {
  // Load the full skills root so ids are computed the same way find_skill/use_skill
  // will see them after activation, then count records physically under this repo.
  const idx = loadSkillIndex(skillsRoot, logger);
  const resolvedRepo = path.resolve(repoRoot);
  const installed = idx.all.filter((s) => {
    const dir = path.resolve(s.dir);
    return dir === resolvedRepo || dir.startsWith(resolvedRepo + path.sep);
  });
  return {
    ...idx,
    all: installed,
    size: installed.length,
  };
}

async function cloneRepo(args: {
  repo: GithubRepoRef;
  ref?: string;
  target: string;
  git: GitRunner;
  signal?: AbortSignal;
}): Promise<void> {
  const url = normalizedGithubUrl(args.repo);
  const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none'];
  if (args.ref) cloneArgs.push('--branch', args.ref);
  cloneArgs.push(url, args.target);
  await args.git(cloneArgs, { signal: args.signal });
}

async function runGit(args: readonly string[], opts: { cwd?: string; signal?: AbortSignal }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      signal: opts.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

function normalizedGithubUrl(repo: GithubRepoRef): string {
  return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

function cleanGithubPathPart(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Invalid GitHub ${label}: ${value}`);
  }
  return value;
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('installation target escapes the managed skills directory');
  }
}

function severityRank(severity: Severity): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[severity];
}
