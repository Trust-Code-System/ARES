export interface PromptInjectionFinding {
  rule: string;
  severity: 'medium' | 'high' | 'critical';
  line: number;
  excerpt: string;
}

const RULES: Array<{ rule: string; severity: PromptInjectionFinding['severity']; pattern: RegExp }> = [
  { rule: 'ignore-instructions', severity: 'critical', pattern: /ignore\s+(?:all\s+)?(?:(?:previous|prior|system|developer|safety)\s+){1,3}(?:instructions|rules|messages|prompts)/i },
  { rule: 'bypass-confirmation', severity: 'critical', pattern: /(?:bypass|disable|skip)\s+(?:approval|confirmation|permission|safety)/i },
  { rule: 'secret-exfiltration', severity: 'critical', pattern: /(?:reveal|print|upload|send|exfiltrate|leak)\s+(?:secrets?|api keys?|tokens?|passwords?)/i },
  { rule: 'hidden-instruction', severity: 'high', pattern: /do\s+not\s+(?:tell|inform|show|mention)\s+(?:the\s+)?user/i },
  { rule: 'role-hijack', severity: 'high', pattern: /you\s+are\s+now\s+(?:unrestricted|jailbroken|root|admin|developer mode)/i },
  { rule: 'obfuscated-payload', severity: 'medium', pattern: /\b(?:base64|atob|fromCharCode|eval\(|ROT13)\b/i },
];

export class PromptInjectionScanner {
  scan(text: string): PromptInjectionFinding[] {
    const findings: PromptInjectionFinding[] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/noqa/i.test(line)) return;
      for (const rule of RULES) {
        if (rule.pattern.test(line)) findings.push({ ...rule, line: index + 1, excerpt: line.trim().slice(0, 180) });
      }
    });
    return findings;
  }
}
