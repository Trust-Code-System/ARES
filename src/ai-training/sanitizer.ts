/**
 * Sensitive-data sanitizer for training datasets.
 *
 * Training files leave the system (uploaded to a tuning provider, committed,
 * shared), so they are the single highest-risk place for a secret or PII to
 * escape. This module statically detects API keys, tokens, private keys, emails,
 * and other credentials in example text and **redacts them with a typed
 * placeholder** before export. It is deliberately conservative on the secret
 * side (better a false positive `‹REDACTED:EMAIL›` than a leaked address) and
 * never performs network or filesystem access itself.
 *
 * This complements — does not duplicate — the skill safety scanner
 * (`src/skills/scanner.ts`), which scans *vendored skills* for injection/exec.
 * Here the concern is *outbound* data hygiene of *our own* generated examples.
 */

export type SecretKind =
  | 'openai_key'
  | 'anthropic_key'
  | 'google_key'
  | 'aws_access_key'
  | 'slack_token'
  | 'github_token'
  | 'private_key_block'
  | 'jwt'
  | 'bearer_token'
  | 'generic_secret_assignment'
  | 'email'
  | 'ip_address'
  | 'phone';

export interface SecretFinding {
  kind: SecretKind;
  /** The matched substring (already length-capped for reporting; never logged elsewhere). */
  match: string;
  /** Character offset of the match in the scanned string. */
  index: number;
}

interface Rule {
  kind: SecretKind;
  pattern: RegExp;
  /** Placeholder substituted for a match. */
  placeholder: string;
}

// Order matters: more specific / higher-entropy patterns first so a key isn't
// partially eaten by the generic assignment rule. All patterns are global.
const RULES: Rule[] = [
  { kind: 'private_key_block', placeholder: '‹REDACTED:PRIVATE_KEY›',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: 'anthropic_key', placeholder: '‹REDACTED:ANTHROPIC_KEY›', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', placeholder: '‹REDACTED:OPENAI_KEY›', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'google_key', placeholder: '‹REDACTED:GOOGLE_KEY›', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'aws_access_key', placeholder: '‹REDACTED:AWS_KEY›', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', placeholder: '‹REDACTED:GITHUB_TOKEN›', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'slack_token', placeholder: '‹REDACTED:SLACK_TOKEN›', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', placeholder: '‹REDACTED:JWT›', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer_token', placeholder: 'Bearer ‹REDACTED:TOKEN›', pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/g },
  // key/secret/password/token assignment: `API_KEY=...`, `"password": "..."`, `token: ...`
  { kind: 'generic_secret_assignment', placeholder: '‹REDACTED:SECRET›',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|pwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9/_+.\-]{6,}["']?/gi },
  { kind: 'email', placeholder: '‹REDACTED:EMAIL›', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'ip_address', placeholder: '‹REDACTED:IP›', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { kind: 'phone', placeholder: '‹REDACTED:PHONE›', pattern: /(?<!\d)(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}(?!\d)/g },
];

const MAX_MATCH_EXCERPT = 80;

/** Scan a string for secrets/PII. Returns findings (no mutation). */
export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      findings.push({ kind: rule.kind, match: m[0].slice(0, MAX_MATCH_EXCERPT), index: m.index });
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++; // avoid zero-width loop
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

/** Redact a string: every detected secret/PII is replaced by a typed placeholder. */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.placeholder);
  }
  return out;
}

export interface SanitizeResult<T> {
  value: T;
  findings: SecretFinding[];
  /** True when anything was redacted. */
  redacted: boolean;
}

/** Sanitize an arbitrary string (input or output text). */
export function sanitizeText(text: string): SanitizeResult<string> {
  const findings = scanSecrets(text);
  return { value: findings.length ? redact(text) : text, findings, redacted: findings.length > 0 };
}

/** Phone matching is heuristic and noisy; callers can opt out via this helper. */
export const PII_KINDS: ReadonlySet<SecretKind> = new Set<SecretKind>(['email', 'ip_address', 'phone']);

/** True when any finding is a hard credential (not just PII) — use to fail exports. */
export function hasCredential(findings: readonly SecretFinding[]): boolean {
  return findings.some((f) => !PII_KINDS.has(f.kind));
}
