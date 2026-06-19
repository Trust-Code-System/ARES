/**
 * Secret detection and redaction.
 *
 * This is a code-level privacy boundary. Anything headed to logs, audit tables,
 * memory, model prompts, or approval queues should pass through here first.
 */

export const REDACTED = '[REDACTED]';

export interface SecretFinding {
  kind: string;
  path?: string;
}

const SENSITIVE_KEY =
  /(^|[_\-\s.])(password|passwd|pwd|otp|one[_\-\s]?time|pin|cvv|cvc|card[_\-\s]?verification|private[_\-\s]?key|seed|seed[_\-\s]?phrase|mnemonic|recovery[_\-\s]?(key|phrase|code)|secret|api[_\-\s]?key|access[_\-\s]?token|refresh[_\-\s]?token|id[_\-\s]?token|auth(orization)?|bearer|cookie|set[_\-\s]?cookie|session(_?id|_?token)?|credential|passphrase)($|[_\-\s.])/i;

const LABELED_SECRET =
  /\b(password|passwd|pwd|otp|one[-_\s]?time(?:\s+password|\s+code)?|verification\s+code|pin|cvv|cvc|card\s+verification(?:\s+value|\s+code)?|private\s+key|seed\s+phrase|mnemonic|recovery\s+(?:key|phrase|code)|api\s+(?:key|secret)|access\s+token|refresh\s+token|auth(?:orization)?(?:\s+header)?|bearer\s+token|cookie|session(?:\s+(?:id|token))?|secret|passphrase)\s*(?::|=|\bis\b)\s*([^\r\n,;]+)/gi;

const SHORT_CODE_SECRET =
  /\b(otp|pin|cvv|cvc|verification\s+code|auth(?:entication)?\s+code)\s+(\d{3,8})\b/gi;

const HEADER_SECRET =
  /\b(authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*([^\r\n]+)/gi;

const PROVIDER_KEYS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactSensitiveData<T>(value: T): T {
  return redactValue(value, '') as T;
}

export function redactSensitiveText(text: string): string {
  let out = text;
  out = out.replace(PEM_PRIVATE_KEY, REDACTED);
  out = out.replace(HEADER_SECRET, (_match, label: string) => `${label}: ${REDACTED}`);
  out = out.replace(LABELED_SECRET, (_match, label: string) => `${label}: ${REDACTED}`);
  out = out.replace(SHORT_CODE_SECRET, (_match, label: string) => `${label} ${REDACTED}`);
  for (const pattern of PROVIDER_KEYS) out = out.replace(pattern, REDACTED);
  out = out.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, '');
    return isLikelyCardNumber(digits) ? REDACTED : match;
  });
  return out;
}

export function findSensitiveData(value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  inspect(value, '', findings);
  return findings;
}

export function containsSensitiveData(value: unknown): boolean {
  return findSensitiveData(value).length > 0;
}

function redactValue(value: unknown, path: string): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry, index) => redactValue(entry, `${path}[${index}]`));

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const sensitiveObject = objectHasSensitiveFieldLabel(input);
  for (const [key, entry] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    if (sensitiveObject && /^(value|text|content|input|answer)$/i.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactValue(entry, path ? `${path}.${key}` : key);
  }
  return output;
}

function inspect(value: unknown, path: string, findings: SecretFinding[]): void {
  if (typeof value === 'string') {
    if (redactSensitiveText(value) !== value) findings.push({ kind: 'secret_text', path });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspect(entry, `${path}[${index}]`, findings));
    return;
  }

  const input = value as Record<string, unknown>;
  if (objectHasSensitiveFieldLabel(input)) findings.push({ kind: 'sensitive_field', path });
  for (const [key, entry] of Object.entries(input)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (isSensitiveKey(key)) {
      findings.push({ kind: 'sensitive_key', path: nextPath });
      continue;
    }
    inspect(entry, nextPath, findings);
  }
}

function objectHasSensitiveFieldLabel(value: Record<string, unknown>): boolean {
  for (const key of ['name', 'label', 'placeholder', 'ariaLabel', 'aria-label', 'type', 'autocomplete', 'autoComplete']) {
    const field = value[key];
    if (typeof field === 'string' && isSensitiveKey(field)) return true;
  }
  return false;
}

function isLikelyCardNumber(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (!Number.isInteger(n)) return false;
    if (doubleDigit) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
