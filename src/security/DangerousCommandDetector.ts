export interface DangerousCommandFinding {
  rule: string;
  severity: 'medium' | 'high' | 'critical';
  line: number;
  excerpt: string;
}

const RULES: Array<{ rule: string; severity: DangerousCommandFinding['severity']; pattern: RegExp }> = [
  { rule: 'recursive-delete', severity: 'critical', pattern: /\brm\s+-rf\b|\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i },
  { rule: 'remote-script-exec', severity: 'critical', pattern: /(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n|]*\|\s*(?:bash|sh|iex|Invoke-Expression)/i },
  { rule: 'permission-widening', severity: 'high', pattern: /\bchmod\s+777\b|\bicacls\b[^\n]*(?:Everyone|Users).*:F/i },
  { rule: 'privileged-exec', severity: 'high', pattern: /\bsudo\b|\bStart-Process\b[^\n]*-Verb\s+RunAs/i },
  { rule: 'eval-exec', severity: 'high', pattern: /\beval\s*\(|\bexec\s*\(|\bInvoke-Expression\b|\biex\b/i },
  { rule: 'git-history-rewrite', severity: 'high', pattern: /\bgit\s+(?:reset\s+--hard|push\s+--force|rebase\b)/i },
];

export class DangerousCommandDetector {
  scan(text: string): DangerousCommandFinding[] {
    const findings: DangerousCommandFinding[] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ ...rule, line: index + 1, excerpt: line.trim().slice(0, 180) });
        }
      }
    });
    return findings;
  }
}
