export interface SecretAccessFinding {
  rule: string;
  severity: 'high' | 'critical';
  line: number;
  excerpt: string;
}

const RULES: Array<{ rule: string; severity: SecretAccessFinding['severity']; pattern: RegExp }> = [
  { rule: 'env-file-read', severity: 'critical', pattern: /\b(?:readFileSync|open|Get-Content|cat|type)\b[^\n]*(?:\.env|credentials|secrets?)/i },
  { rule: 'env-dump', severity: 'critical', pattern: /\b(?:process\.env|os\.environ|printenv|Get-ChildItem\s+Env:)\b/i },
  { rule: 'ssh-key-access', severity: 'critical', pattern: /\.ssh[\\/](?:id_rsa|id_ed25519|config|known_hosts)/i },
  { rule: 'browser-credential-store', severity: 'critical', pattern: /Login Data|Cookies|keychain|Credential Manager|password manager/i },
  { rule: 'secret-like-label', severity: 'high', pattern: /\b(api[_ -]?key|secret|token|password|private[_ -]?key|seed phrase)\b/i },
];

export class SecretAccessDetector {
  scan(text: string): SecretAccessFinding[] {
    const findings: SecretAccessFinding[] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) findings.push({ ...rule, line: index + 1, excerpt: line.trim().slice(0, 180) });
      }
    });
    return findings;
  }
}
