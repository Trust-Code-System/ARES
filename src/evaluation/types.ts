/**
 * Behavioural evaluation — types.
 *
 * Adapted from the InstructGPT / summarize-from-feedback eval idea
 * (docs/github-extraction-report.md, repos #1/#3): assert that ARES *behaves*
 * correctly, not just that a unit returns the right value. The runner is
 * deterministic and offline by default — it asserts ARES's real safety/routing
 * guarantees (tool gating, the secret detector, skill routing) with no model
 * calls, mirroring tests/routing.eval.test.ts.
 *
 * Cases that genuinely need a model to judge (web-research quality, citation
 * accuracy, summary faithfulness) carry an `llm_judge` probe; the static
 * evaluator reports those as SKIP rather than faking a pass, leaving a clean
 * extension point for an LLM-judge evaluator later.
 */

/** The prompt's eval categories. A case is tagged with exactly one. */
export const EVAL_CATEGORIES = [
  'instruction_following',
  'tool_selection',
  'file_handling',
  'web_research',
  'citation_accuracy',
  'form_filling_safety',
  'email_safety',
  'document_generation',
  'coding_help',
  'memory_correctness',
  'privacy_protection',
  'confirmation_behavior',
  'refusal_behavior',
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/**
 * A probe is the deterministic question a case asks. Each maps to a real ARES
 * component:
 *  - tool_gating   → ToolRegistry tool.kind (state_mutating ⇒ confirmation)
 *  - tool_presence → ToolRegistry.has
 *  - privacy       → security/redactor.containsSensitiveData
 *  - skill_routing → the vendored skill index
 *  - llm_judge     → needs a model; skipped by the static evaluator
 */
export type EvalProbe =
  | { type: 'tool_gating'; tool: string; requiresConfirmation: boolean }
  | { type: 'tool_presence'; tool: string; registered: boolean }
  | { type: 'privacy'; input: unknown; blocked: boolean }
  | { type: 'skill_routing'; request: string; expectMatch: string; topK?: number }
  | { type: 'llm_judge'; input: string; expect: string };

export interface EvalCase {
  name: string;
  category: EvalCategory;
  risk?: 'low' | 'medium' | 'high';
  probe: EvalProbe;
}

export type EvalStatus = 'pass' | 'fail' | 'skip';

/** What an evaluator returns for one case. */
export interface EvalOutcome {
  status: EvalStatus;
  detail: string;
}

export interface EvalResult extends EvalOutcome {
  name: string;
  category: EvalCategory;
}

export interface CategoryTally {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  byCategory: Record<string, CategoryTally>;
  results: EvalResult[];
}

/** Judges one case. Sync or async; the runner awaits either. */
export type Evaluator = (c: EvalCase) => Promise<EvalOutcome> | EvalOutcome;
