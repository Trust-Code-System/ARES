/**
 * The eval runner — pure orchestration.
 *
 * Runs each case through an injected {@link Evaluator}, tolerates a throwing
 * evaluator (counts it as a fail rather than crashing the suite), and tallies a
 * per-category {@link EvalReport}. Knows nothing about ARES internals, so it is
 * trivially unit-testable; the real signal lives in the evaluator (see
 * aresEvaluator.ts).
 */

import {
  EVAL_CATEGORIES,
  type CategoryTally,
  type EvalCase,
  type EvalReport,
  type EvalResult,
  type Evaluator,
} from './types.js';

export async function runEval(cases: readonly EvalCase[], evaluate: Evaluator): Promise<EvalReport> {
  const results: EvalResult[] = [];

  for (const c of cases) {
    let outcome;
    try {
      outcome = await evaluate(c);
    } catch (err) {
      outcome = { status: 'fail' as const, detail: `evaluator threw: ${(err as Error).message}` };
    }
    results.push({ name: c.name, category: c.category, ...outcome });
  }

  const byCategory: Record<string, CategoryTally> = {};
  const tally = (cat: string): CategoryTally =>
    (byCategory[cat] ??= { total: 0, passed: 0, failed: 0, skipped: 0 });

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    const t = tally(r.category);
    t.total += 1;
    if (r.status === 'pass') { t.passed += 1; passed += 1; }
    else if (r.status === 'fail') { t.failed += 1; failed += 1; }
    else { t.skipped += 1; skipped += 1; }
  }

  return { total: results.length, passed, failed, skipped, byCategory, results };
}

/** Render a report as a compact, human-readable string (for the CLI). */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  const icon = (s: EvalResult['status']) => (s === 'pass' ? '✓' : s === 'fail' ? '✗' : '−');

  for (const r of report.results) {
    lines.push(`  ${icon(r.status)} [${r.category}] ${r.name}${r.status === 'pass' ? '' : ` — ${r.detail}`}`);
  }

  lines.push('');
  lines.push('By category:');
  for (const cat of EVAL_CATEGORIES) {
    const t = report.byCategory[cat];
    if (!t) continue;
    lines.push(`  ${cat}: ${t.passed}/${t.total} pass${t.skipped ? ` (${t.skipped} skipped)` : ''}${t.failed ? ` — ${t.failed} FAIL` : ''}`);
  }

  lines.push('');
  lines.push(
    `Total: ${report.passed}/${report.total} passed` +
      `${report.skipped ? `, ${report.skipped} skipped` : ''}` +
      `${report.failed ? `, ${report.failed} FAILED` : ''}`,
  );
  return lines.join('\n');
}
