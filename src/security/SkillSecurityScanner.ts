import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DangerousCommandDetector, type DangerousCommandFinding } from './DangerousCommandDetector.js';
import { PromptInjectionScanner, type PromptInjectionFinding } from './PromptInjectionScanner.js';
import { SecretAccessDetector, type SecretAccessFinding } from './SecretAccessDetector.js';

export type SkillSecuritySeverity = 'medium' | 'high' | 'critical';

export interface SkillSecurityFinding {
  scanner: 'prompt_injection' | 'dangerous_command' | 'secret_access' | 'network' | 'obfuscation';
  rule: string;
  severity: SkillSecuritySeverity;
  file: string;
  line: number;
  excerpt: string;
}

export interface SkillSecurityScanResult {
  root: string;
  passed: boolean;
  findings: SkillSecurityFinding[];
}

const SCRIPT_EXTENSIONS = new Set(['.py', '.js', '.ts', '.mjs', '.cjs', '.sh', '.ps1', '.bat', '.cmd']);

export class SkillSecurityScanner {
  constructor(
    private readonly promptScanner = new PromptInjectionScanner(),
    private readonly commandDetector = new DangerousCommandDetector(),
    private readonly secretDetector = new SecretAccessDetector(),
  ) {}

  scanSkillDirectory(dir: string): SkillSecurityScanResult {
    const root = path.resolve(dir);
    const findings: SkillSecurityFinding[] = [];
    for (const file of walk(root)) {
      const ext = path.extname(file).toLowerCase();
      if (path.basename(file) === 'SKILL.md' || path.basename(file) === 'metadata.json') {
        findings.push(...this.mapPrompt(file, this.promptScanner.scan(readText(file))));
        findings.push(...this.mapSecret(file, this.secretDetector.scan(readText(file))));
      }
      if (SCRIPT_EXTENSIONS.has(ext)) {
        const text = readText(file);
        findings.push(...this.mapCommand(file, this.commandDetector.scan(text)));
        findings.push(...this.mapSecret(file, this.secretDetector.scan(text)));
        findings.push(...scanNetwork(file, text));
      }
    }
    return {
      root,
      passed: !findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high'),
      findings,
    };
  }

  private mapPrompt(file: string, findings: PromptInjectionFinding[]): SkillSecurityFinding[] {
    return findings.map((finding) => ({ scanner: 'prompt_injection', file, ...finding }));
  }

  private mapCommand(file: string, findings: DangerousCommandFinding[]): SkillSecurityFinding[] {
    return findings.map((finding) => ({ scanner: 'dangerous_command', file, ...finding }));
  }

  private mapSecret(file: string, findings: SecretAccessFinding[]): SkillSecurityFinding[] {
    return findings.map((finding) => ({ scanner: 'secret_access', file, ...finding }));
  }
}

function scanNetwork(file: string, text: string): SkillSecurityFinding[] {
  const findings: SkillSecurityFinding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (/\b(fetch|axios|requests\.|urllib\.request|http\.client|socket\.socket|WebSocket)\b/i.test(line)) {
      findings.push({
        scanner: 'network',
        rule: 'network-access',
        severity: 'medium',
        file,
        line: index + 1,
        excerpt: line.trim().slice(0, 180),
      });
    }
    if (/[A-Za-z0-9+/]{120,}={0,2}/.test(line)) {
      findings.push({
        scanner: 'obfuscation',
        rule: 'long-encoded-payload',
        severity: 'high',
        file,
        line: index + 1,
        excerpt: line.trim().slice(0, 180),
      });
    }
  });
  return findings;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(root, entry);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(full));
    else if (isFile) out.push(full);
  }
  return out;
}
