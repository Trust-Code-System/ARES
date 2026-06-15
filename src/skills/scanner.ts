/**
 * Skill safety scanner (Phase 9 — supply-chain vetting for vendored skills).
 *
 * Third-party skills are loaded verbatim into the model's context by `use_skill`,
 * and any Python they bundle can be run (only through the gated `run_python`
 * tool). That makes a vendored `SKILL.md` an *untrusted input* the same way a
 * fetched web page is. This module statically scans skill text for the patterns
 * that matter — prompt-injection / role-hijack / safety-bypass language in the
 * playbook body, and network/exec/secret access in bundled scripts — and grades
 * each hit so vetting can gate on severity.
 *
 * It is deliberately conservative and *advisory*: it never executes anything and
 * never edits a skill. A line carrying a `noqa` marker (the upstream
 * `<!-- noqa: SEC-AUDITOR -->` convention) is treated as an intentional,
 * reviewed example — this is what lets the security-education skills, which quote
 * attack strings as their subject matter, scan clean. The pattern set is the
 * single source of truth shared by the `scan:skills` CLI and any future
 * load-time guard.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SkillRecord } from './loader.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'system_override'
  | 'role_hijack'
  | 'safety_bypass'
  | 'data_exfil'
  | 'network'
  | 'dangerous_exec'
  | 'secret_access';

export interface Finding {
  /** Stable rule id for allowlisting / reporting. */
  rule: string;
  category: FindingCategory;
  severity: Severity;
  /** 1-based line number within the scanned file. */
  line: number;
  /** The matched line, trimmed and length-capped for the report. */
  excerpt: string;
}

interface Rule {
  id: string;
  category: FindingCategory;
  severity: Severity;
  pattern: RegExp;
  /** Where this rule applies. `prose` = SKILL.md bodies; `code` = bundled scripts. */
  scope: 'prose' | 'code' | 'any';
}

/** Severity ordering for thresholds (higher = worse). */
export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * The rule set. Prose rules hunt for instructions aimed at the *reading model*
 * (the injection surface); code rules hunt for capabilities a bundled script
 * could abuse if it were ever run. Patterns are intentionally narrow to keep the
 * false-positive rate low — domain text that merely *mentions* "exfiltration" or
 * "API key" must not trip, only text that instructs or performs.
 */
const RULES: Rule[] = [
  // --- Prompt injection against the model reading the playbook ---
  {
    id: 'system-override',
    category: 'system_override',
    severity: 'critical',
    scope: 'prose',
    pattern:
      /ignore\s+(?:the\s+)?(?:(?:previous|above|prior|all|earlier|system|preceding)\s+){1,3}(?:instruction|prompt|rule|context|direction|message)/i,
  },
  {
    id: 'disregard-rules',
    category: 'system_override',
    severity: 'critical',
    scope: 'prose',
    pattern: /disregard\s+(?:the\s+)?(?:previous|above|system|safety|all)\s+\w+/i,
  },
  {
    id: 'role-hijack',
    category: 'role_hijack',
    severity: 'critical',
    scope: 'prose',
    // Narrowed to *dangerous* re-identification — a skill legitimately saying
    // "you are now a marketing expert" must not trip; "you are now an
    // unrestricted AI / jailbroken / root" must.
    pattern:
      /you\s+are\s+now\s+(?:an?\s+)?(?:unrestricted|jailbroken|uncensored|root\b|admin\b|sudo\b|dan\b|an\s+ai\s+(?:with\s+no|without\s+(?:rules|restrictions)))|pretend\s+(?:you\s+have\s+no|to\s+have\s+no\s+(?:rules|restrictions))|act\s+as\s+(?:if\s+you\s+have\s+no|root\b)/i,
  },
  {
    id: 'jailbreak-persona',
    category: 'role_hijack',
    severity: 'high',
    scope: 'prose',
    pattern: /\bDAN\s+mode\b|developer\s+mode\s+(?:is\s+)?enabled|all\s+restrictions\s+(?:are\s+)?lifted/i,
  },
  {
    id: 'safety-bypass',
    category: 'safety_bypass',
    severity: 'critical',
    scope: 'prose',
    pattern:
      /(?:skip|disable|turn\s+off|ignore)\s+(?:the\s+|all\s+)?(?:safety\s+(?:check|filter|control|mechanism|guard)|content\s+filter|guardrail|confirmation\s+(?:step|gate|prompt)|approval\s+(?:step|gate))|bypass\s+(?:the\s+)?(?:safety|confirmation|approval|permission)\b/i,
  },
  {
    id: 'secret-exfil-instruction',
    category: 'data_exfil',
    severity: 'critical',
    scope: 'prose',
    pattern:
      /(?:read|open|print|send|upload|leak|reveal|paste)\s+(?:the\s+)?(?:\.env|env\s+file|api[\s_-]?keys?|secrets?|credentials?)\b/i,
  },
  {
    id: 'hidden-instruction',
    category: 'system_override',
    severity: 'high',
    scope: 'prose',
    // Instructions addressed to "the assistant/model/AI" to do something silently.
    pattern: /do\s+not\s+(?:tell|inform|mention\s+to|reveal\s+to)\s+(?:the\s+)?(?:user|principal|human)/i,
  },

  // --- Capabilities in bundled scripts (only ever run via gated run_python) ---
  {
    id: 'network-call',
    category: 'network',
    severity: 'medium',
    scope: 'code',
    pattern: /\b(?:requests\.(?:get|post|put|delete)|urllib\.request|http\.client|socket\.socket|aiohttp)\b/,
  },
  {
    id: 'shell-exec',
    category: 'dangerous_exec',
    severity: 'high',
    scope: 'code',
    pattern: /\bos\.system\s*\(|subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True|\bexec\s*\(|\beval\s*\(/,
  },
  {
    id: 'curl-pipe-shell',
    category: 'dangerous_exec',
    severity: 'critical',
    scope: 'any',
    pattern: /(?:curl|wget)\s+[^\n|]*\|\s*(?:ba)?sh\b/i,
  },
  {
    id: 'secret-env-read',
    category: 'secret_access',
    severity: 'low',
    scope: 'code',
    // os.environ access is common and usually legitimate; flagged low for review.
    pattern: /os\.environ(?:\.get)?\s*[\[(]\s*['"][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)['"]/,
  },
];

const NOQA = /noqa(?::\s*[\w-]+)?/i;
const MAX_EXCERPT = 160;

/**
 * Negation/advice cues. A line warning *against* an action ("never read .env",
 * "do not bypass the gate") describes the threat rather than commanding it, so
 * the imperative-instruction rules (exfil / safety-bypass) are suppressed on it.
 * Capability rules in code (network/exec) ignore this — code does, not advises.
 */
const NEGATION = /\b(?:never|do\s+not|don't|avoid|should\s+not|shouldn't|must\s+not|prevent|instead\s+of|rather\s+than|without)\b/i;
const NEGATABLE: ReadonlySet<FindingCategory> = new Set<FindingCategory>(['data_exfil', 'safety_bypass']);

/**
 * Scan one file's text against the rules for a given scope. Lines bearing a
 * `noqa` marker are skipped (intentional, reviewed examples).
 */
export function scanText(text: string, scope: 'prose' | 'code'): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  const active = RULES.filter((r) => r.scope === scope || r.scope === 'any');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (NOQA.test(line)) continue;
    const negated = NEGATION.test(line);
    for (const rule of active) {
      if (negated && NEGATABLE.has(rule.category)) continue;
      if (rule.pattern.test(line)) {
        findings.push({
          rule: rule.id,
          category: rule.category,
          severity: rule.severity,
          line: i + 1,
          excerpt: line.trim().slice(0, MAX_EXCERPT),
        });
      }
    }
  }
  return findings;
}

export interface SkillScanResult {
  id: string;
  /** File the finding came from (the SKILL.md or a bundled script), absolute. */
  findings: Array<Finding & { file: string }>;
  /** Highest severity across all findings, or undefined when clean. */
  worst?: Severity;
}

/**
 * Scan one skill: its playbook body (prose rules) plus every bundled script
 * (code rules). Unreadable files are skipped, never thrown.
 */
export function scanSkill(skill: SkillRecord): SkillScanResult {
  const out: Array<Finding & { file: string }> = [];

  const addFrom = (file: string, scope: 'prose' | 'code'): void => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const f of scanText(text, scope)) out.push({ ...f, file });
  };

  addFrom(skill.bodyPath, 'prose');
  for (const script of skill.scripts) addFrom(script, 'code');

  let worst: Severity | undefined;
  for (const f of out) {
    if (worst === undefined || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) {
      worst = f.severity;
    }
  }
  return worst ? { id: skill.id, findings: out, worst } : { id: skill.id, findings: out };
}

/** Scan every skill in an index. Returns only skills with at least one finding. */
export function scanSkills(skills: readonly SkillRecord[]): SkillScanResult[] {
  return skills.map(scanSkill).filter((r) => r.findings.length > 0);
}

/** True when any result is at or above the given severity threshold. */
export function hasSeverityAtLeast(results: readonly SkillScanResult[], threshold: Severity): boolean {
  return results.some((r) => r.worst !== undefined && SEVERITY_RANK[r.worst] >= SEVERITY_RANK[threshold]);
}

/** Render a human-readable report grouped by skill. `root` shortens file paths. */
export function formatScanReport(results: readonly SkillScanResult[], root: string): string {
  if (results.length === 0) return 'No findings — all scanned skills are clean.';
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`\n${r.id}  [worst: ${r.worst}]`);
    for (const f of r.findings) {
      const rel = path.relative(root, f.file);
      lines.push(`  ${sevTag(f.severity)} ${f.rule} (${f.category}) — ${rel}:${f.line}`);
      lines.push(`      ${f.excerpt}`);
    }
  }
  return lines.join('\n');
}

function sevTag(s: Severity): string {
  return { critical: '[CRIT]', high: '[HIGH]', medium: '[MED ]', low: '[LOW ]' }[s];
}
