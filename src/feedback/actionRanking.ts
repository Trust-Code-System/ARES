/**
 * Action ranking — turn the audit log into preference data, no human needed.
 *
 * Adapted from the lm-human-preferences "rules-based reward" idea
 * (docs/github-extraction-report.md, repo #2): score each run against ARES's
 * safety rules, and mint {prompt, chosen, rejected} preference pairs from the
 * gate's REAL decisions. The chosen side is the safe behaviour that actually
 * happened (paused for confirmation; refused a secret); the rejected side is the
 * unsafe counterfactual. These pairs (source `action_ranking`) seed the same
 * table explicit feedback fills, so a future DPO run reinforces the gate policy
 * without any human labelling.
 *
 * Honest by construction: negatives the gate structurally PREVENTS (sending mail
 * without approval, etc.) don't appear as real events — that's the point — so we
 * only score positives we can observe and synthesise their unsafe counterfactual.
 */

import type { AgentInput, AgentRunResult, AuditEvent } from '../types.js';
import { redactSensitiveText } from '../security/redactor.js';
import type { FeedbackStore, NewPreferencePair } from './store.js';

/** A named scoring rule. `delta` is its contribution to the run's action score. */
export interface ActionRule {
  name: string;
  delta: number;
  description: string;
}

export const ACTION_RULES: ActionRule[] = [
  { name: 'asks_confirmation_before_risky_action', delta: 1, description: 'Paused a state-changing action for confirmation instead of acting unilaterally.' },
  { name: 'keeps_user_data_private', delta: 1, description: 'Refused to pass a secret (password/OTP/key/token) to a tool.' },
  { name: 'uses_tools', delta: 1, description: 'Used a tool to do the work rather than guessing.' },
];

export interface RuleHit {
  rule: string;
  delta: number;
  /** The tool the hit concerns, when applicable. */
  tool?: string;
}

export interface ActionScore {
  score: number;
  hits: RuleHit[];
}

/** Pure: score a run's audit events against {@link ACTION_RULES}. */
export function scoreRun(events: readonly AuditEvent[]): ActionScore {
  const hits: RuleHit[] = [];
  let usedTool = false;

  for (const e of events) {
    const tool = typeof e.detail.tool === 'string' ? e.detail.tool : undefined;
    if (e.type === 'tool_gate_decision' && e.detail.approved === false) {
      hits.push({ rule: 'asks_confirmation_before_risky_action', delta: 1, ...(tool ? { tool } : {}) });
    }
    if (e.type === 'tool_failed' && e.detail.error === 'sensitive input blocked') {
      hits.push({ rule: 'keeps_user_data_private', delta: 1, ...(tool ? { tool } : {}) });
    }
    if (e.type === 'tool_executed') usedTool = true;
  }
  if (usedTool) hits.push({ rule: 'uses_tools', delta: 1 });

  const ruleDelta = new Map(ACTION_RULES.map((r) => [r.name, r.delta]));
  const score = hits.reduce((sum, h) => sum + (ruleDelta.get(h.rule) ?? 0), 0);
  return { score, hits };
}

/**
 * Build the {prompt, chosen, rejected} pairs a run earns. Deduplicated by
 * (rule, tool) and capped, so one run can't flood the table. The prompt is the
 * user's input, redacted.
 */
export function preferencePairsFromRun(
  events: readonly AuditEvent[],
  input: AgentInput,
  maxPairs = 5,
): NewPreferencePair[] {
  const prompt = redactSensitiveText(input.text).slice(0, 2000);
  const seen = new Set<string>();
  const pairs: NewPreferencePair[] = [];

  for (const hit of scoreRun(events).hits) {
    if (hit.rule === 'uses_tools') continue; // not a safety contrast worth a pair
    const key = `${hit.rule}:${hit.tool ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const tool = hit.tool ?? 'a state-changing action';
    if (hit.rule === 'asks_confirmation_before_risky_action') {
      pairs.push({
        prompt,
        chosen: `Paused and asked the user to confirm before running ${tool} (a state-changing action).`,
        rejected: `Ran ${tool} immediately, without asking for confirmation.`,
        reason: 'Asks for confirmation before a risky/irreversible action.',
        source: 'action_ranking',
        safetyLabel: 'safe',
      });
    } else if (hit.rule === 'keeps_user_data_private') {
      pairs.push({
        prompt,
        chosen: `Refused to pass the secret to ${tool}; asked the user to enter it manually.`,
        rejected: `Passed the secret value directly to ${tool}.`,
        reason: 'Never routes passwords/keys/tokens through tools, logs, or models.',
        source: 'action_ranking',
        safetyLabel: 'privacy',
      });
    }
    if (pairs.length >= maxPairs) break;
  }
  return pairs;
}

/**
 * A run-completion hook the orchestrator calls (guarded). Decoupled from the
 * audit log and feedback store via this narrow signature so the orchestrator
 * depends on neither directly.
 */
export type PreferenceSeeder = (ctx: {
  events: AuditEvent[];
  input: AgentInput;
  result: AgentRunResult;
}) => Promise<void>;

/** Wire a seeder over a feedback store. Only seeds completed/maxed runs. */
export function buildPreferenceSeeder(store: FeedbackStore): PreferenceSeeder {
  return async ({ events, input, result }) => {
    if (result.fastChat) return;
    if (result.stopReason !== 'completed' && result.stopReason !== 'max_iterations') return;
    for (const pair of preferencePairsFromRun(events, input)) {
      await store.addPreference(pair);
    }
  };
}
