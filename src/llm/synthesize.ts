/**
 * A tiny single-shot LLM helper for tools that need to synthesize text.
 *
 * Several capabilities (deep research, meeting-transcript analysis) are not
 * agentic loops — they make one focused model call to turn gathered material
 * into a written answer. Rather than each tool reaching for a concrete provider
 * SDK, they depend on this provider-agnostic {@link Synthesizer}, which is bound
 * to whichever {@link MessageClient} the composition root already built (and
 * therefore honours the configured provider + tier). No tools, no thinking
 * overhead, no memory — just system + user → text.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ModelTier } from './anthropic.js';
import type { MessageClient } from '../agent/orchestrator.js';

export interface SynthesizeOptions {
  /** Model tier to use. Defaults to `reasoning` (synthesis is quality work). */
  tier?: ModelTier;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Turn a system instruction + user content into a single text answer. */
export type Synthesizer = (
  system: string,
  user: string,
  opts?: SynthesizeOptions,
) => Promise<string>;

/** Bind a {@link Synthesizer} to a concrete message client. */
export function buildSynthesizer(client: MessageClient): Synthesizer {
  return async (system, user, opts) => {
    const message = await client.createMessage({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      tier: opts?.tier ?? 'reasoning',
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      // Synthesis doesn't need interleaved reasoning traces; keep it lean.
      thinking: { type: 'disabled' },
    });
    return extractText(message.content);
  };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
