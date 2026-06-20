/**
 * Model router — offline. Exercises the pure routing policy (provider + tier
 * selection, override, availability fallback) and the ModelRouter's runtime
 * fallback-on-error behaviour with fake runtimes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectRoute, ModelRouter, type Provider } from '../src/llm/router.js';
import type { LlmRuntime } from '../src/llm/factory.js';

const ALL = new Set<Provider>(['anthropic', 'openai', 'gemini']);
const ORDER: Provider[] = ['anthropic', 'openai', 'gemini'];

describe('selectRoute — policy', () => {
  it('routes code & architecture and long-context to Claude (reasoning)', () => {
    assert.equal(selectRoute({ kind: 'code' }, ALL, ORDER).provider, 'anthropic');
    assert.equal(selectRoute({ kind: 'architecture' }, ALL, ORDER).provider, 'anthropic');
    const lc = selectRoute({ needsLongContext: true }, ALL, ORDER);
    assert.equal(lc.provider, 'anthropic');
    assert.equal(lc.tier, 'reasoning');
  });

  it('routes structured output and latency-sensitive work to OpenAI', () => {
    assert.equal(selectRoute({ needsStructuredOutput: true }, ALL, ORDER).provider, 'openai');
    const chat = selectRoute({ latencySensitive: true }, ALL, ORDER);
    assert.equal(chat.provider, 'openai');
    assert.equal(chat.tier, 'fast');
    assert.equal(selectRoute({ kind: 'extraction' }, ALL, ORDER).tier, 'fast');
  });

  it('honours a manual override over policy', () => {
    const r = selectRoute({ kind: 'code', override: { provider: 'gemini', tier: 'fast' } }, ALL, ORDER);
    assert.equal(r.provider, 'gemini');
    assert.equal(r.tier, 'fast');
    assert.match(r.reason, /override/);
  });

  it('falls back when the preferred provider is unavailable', () => {
    const onlyGemini = new Set<Provider>(['gemini']);
    const r = selectRoute({ kind: 'code' }, onlyGemini, ['gemini']);
    assert.equal(r.provider, 'gemini'); // wanted Claude, only Gemini available
    assert.match(r.reason, /unavailable/);
  });

  it('sends general tasks to the head of the fallback order (default provider)', () => {
    assert.equal(selectRoute({ kind: 'general' }, ALL, ['openai', 'anthropic', 'gemini']).provider, 'openai');
  });
});

describe('ModelRouter — runtime', () => {
  const fakeRuntime = (p: Provider, behavior: 'ok' | 'throw'): LlmRuntime => ({
    provider: p,
    reasoningModel: `${p}-reasoning`,
    fastModel: `${p}-fast`,
    client: {
      // Minimal MessageClient surface used by the test fn.
      async createMessage() {
        if (behavior === 'throw') throw new Error(`${p} down`);
        return { provider: p } as never;
      },
    } as never,
  });

  it('resolve() returns the policy provider, tier, and concrete model', () => {
    const router = new ModelRouter(
      new Map([
        ['anthropic', fakeRuntime('anthropic', 'ok')],
        ['openai', fakeRuntime('openai', 'ok')],
      ]),
      'anthropic',
    );
    const m = router.resolve({ kind: 'code' });
    assert.equal(m.provider, 'anthropic');
    assert.equal(m.model, 'anthropic-reasoning');
  });

  it('resolveChain() lists the routed primary first, then the rest in fallback order, all same tier', () => {
    const router = new ModelRouter(
      new Map([
        ['anthropic', fakeRuntime('anthropic', 'ok')],
        ['openai', fakeRuntime('openai', 'ok')],
        ['gemini', fakeRuntime('gemini', 'ok')],
      ]),
      'openai',
    );
    const chain = router.resolveChain({ override: { provider: 'openai', tier: 'fast' } });
    assert.deepEqual(chain.map((m) => m.provider), ['openai', 'anthropic', 'gemini']);
    assert.deepEqual(chain.map((m) => m.model), ['openai-fast', 'anthropic-fast', 'gemini-fast']);
  });

  it('withFallback() moves to the next provider when the first throws', async () => {
    const router = new ModelRouter(
      new Map([
        ['anthropic', fakeRuntime('anthropic', 'throw')],
        ['openai', fakeRuntime('openai', 'ok')],
      ]),
      'anthropic',
    );
    const used = await router.withFallback({ kind: 'code' }, async (m) => {
      await m.client.createMessage({} as never);
      return m.provider;
    });
    assert.equal(used, 'openai');
  });

  it('withFallback() throws the last error when every provider fails', async () => {
    const router = new ModelRouter(new Map([['openai', fakeRuntime('openai', 'throw')]]), 'openai');
    await assert.rejects(
      router.withFallback({ kind: 'general' }, async (m) => {
        await m.client.createMessage({} as never);
        return m.provider;
      }),
      /openai down/,
    );
  });
});
