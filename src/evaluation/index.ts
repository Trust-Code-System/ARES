/**
 * Behavioural evaluation (public surface).
 *
 * A deterministic, offline regression harness that asserts ARES's real safety
 * and routing guarantees from versioned JSON cases. See aresEvaluator.ts for the
 * probe→guarantee mapping and ai-training/evaluations/ for the cases. Run it with
 * `npm run eval`.
 */

export * from './types.js';
export * from './runner.js';
export * from './aresEvaluator.js';
export * from './cases.js';
export * from './judge.js';
