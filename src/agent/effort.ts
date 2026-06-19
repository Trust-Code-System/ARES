/**
 * Effort / response-depth control.
 *
 * Orthogonal to the model switch (which picks provider + speed tier), effort
 * controls how *hard* ARES works a turn: how many tool round-trips it may take,
 * which tier to bias toward, and how thorough vs. terse the answer should be.
 * It's a per-turn knob the UI can expose ("Quick" / "Standard" / "Deep").
 *
 * Parsing is pure and total: anything unrecognized degrades to `standard`, so a
 * stale or hand-rolled value can never break a turn.
 */

import type { ModelTier } from '../llm/anthropic.js';

export const EFFORT_LEVELS = ['quick', 'standard', 'deep'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface EffortProfile {
  /** Bias the loop toward this tier (a non-auto explicit model choice still wins). */
  tierBias?: ModelTier;
  /** Hard cap on tool round-trips for this turn (applied as a min with the global cap). */
  maxIterationsCap?: number;
  /** Extra system guidance appended for the turn. */
  instruction?: string;
  /** When true, skip the conversational fast-path even for chatty input (deep means deep). */
  forceFullAgent?: boolean;
}

const PROFILES: Record<Effort, EffortProfile> = {
  quick: {
    tierBias: 'fast',
    maxIterationsCap: 3,
    instruction:
      'Effort: QUICK. Answer directly and briefly. Use at most one or two tool calls — ' +
      'only if essential — and do not over-explain.',
  },
  standard: {},
  deep: {
    tierBias: 'reasoning',
    forceFullAgent: true,
    instruction:
      'Effort: DEEP. Be thorough and rigorous: consider multiple angles, use tools to ' +
      'verify important claims, check your own reasoning, and produce a complete, ' +
      'well-structured answer. Prefer correctness and coverage over brevity.',
  },
};

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Parse a raw `effort` value into a level, defaulting to `standard`. */
export function parseEffort(raw: string | undefined | null): Effort {
  const value = (raw ?? '').trim().toLowerCase();
  return isEffort(value) ? value : 'standard';
}

/** The behavioural profile for an effort level. */
export function effortProfile(effort: Effort | undefined): EffortProfile {
  return PROFILES[effort ?? 'standard'];
}
