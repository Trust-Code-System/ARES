/**
 * Per-turn model selection (HUD "model switch").
 *
 * The chat UI sends an optional `model` choice with each turn. It's one of:
 *   - `auto`            — let ARES pick the speed tier from the question's shape
 *                         (simple → fast model, complex → reasoning model).
 *   - `<provider>:<tier>` — force a specific provider + tier, e.g. `anthropic:fast`,
 *                         `openai:reasoning`. The provider must have a key configured;
 *                         the {@link ModelRouter} falls back gracefully if it doesn't.
 *   - `fast` / `smart`  — shorthand for the configured default provider's fast /
 *                         reasoning tier (no provider switch).
 *
 * Parsing is pure and total: anything unrecognized degrades to `auto`, so a stale
 * or hand-rolled value can never break a turn.
 */

import type { Provider, ModelTier } from './router.js';

const PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'gemini']);

export interface ParsedModelChoice {
  /** `auto` lets the agent classify; `explicit` forces a tier (and maybe a provider). */
  mode: 'auto' | 'explicit';
  /** Set only when the user named a provider; absent means "the default provider". */
  provider?: Provider;
  /** Set for every explicit choice. */
  tier?: ModelTier;
}

/** Parse a raw `model` value from the wire into a {@link ParsedModelChoice}. */
export function parseModelChoice(raw: string | undefined | null): ParsedModelChoice {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'auto') return { mode: 'auto' };

  // Shorthands for the default provider's two tiers.
  if (value === 'fast') return { mode: 'explicit', tier: 'fast' };
  if (value === 'smart' || value === 'reasoning') return { mode: 'explicit', tier: 'reasoning' };

  // `<provider>:<tier>` form.
  const [provider, tierRaw] = value.split(':');
  if (provider && PROVIDERS.has(provider)) {
    const tier: ModelTier = tierRaw === 'fast' ? 'fast' : 'reasoning';
    return { mode: 'explicit', provider: provider as Provider, tier };
  }

  // Unrecognized → safe default.
  return { mode: 'auto' };
}

/** Human-readable provider name for UI labels. */
export function providerDisplayName(provider: Provider): string {
  switch (provider) {
    case 'anthropic': return 'Claude';
    case 'openai': return 'GPT';
    case 'gemini': return 'Gemini';
  }
}

/** A selectable model option surfaced to the UI. */
export interface ModelOption {
  /** Wire value sent back as the `model` choice (e.g. `auto`, `anthropic:fast`). */
  id: string;
  /** Short label for the dropdown (e.g. `Auto`, `Claude · Fast`). */
  label: string;
  /** The concrete model id behind this option (empty for `auto`). */
  detail: string;
}
