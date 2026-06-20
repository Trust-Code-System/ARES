/**
 * FallbackMessageClient — offline. Verifies the agent loop's cross-provider
 * failover: it tries the next keyed provider when one errors, but never on a user
 * abort and never once text has already streamed to the user.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FallbackMessageClient, type MessageClient } from '../src/agent/orchestrator.js';
import type { ResolvedModel, Provider } from '../src/llm/router.js';
import type { CreateMessageParams } from '../src/llm/anthropic.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** A chain link whose client runs `impl` and reports `provider` via the message id. */
function link(provider: Provider, impl: MessageClient['createMessage']): ResolvedModel {
  return {
    provider,
    tier: 'reasoning',
    model: `${provider}-reasoning`,
    reason: 'test',
    client: { createMessage: impl } as MessageClient,
  } as ResolvedModel;
}

/** A client that resolves to a message tagged with `id` (used to assert who answered). */
const ok = (id: string): MessageClient['createMessage'] => async () => ({ id } as never);
/** A client that throws `msg`. */
const fail = (msg: string): MessageClient['createMessage'] => async () => {
  throw new Error(msg);
};

describe('FallbackMessageClient', () => {
  const params = {} as CreateMessageParams;

  it('returns the first provider when it succeeds, without trying the rest', async () => {
    let secondCalled = false;
    const c = new FallbackMessageClient(
      [link('openai', ok('from-openai')), link('anthropic', async () => { secondCalled = true; return {} as never; })],
      noopLogger,
    );
    const msg = await c.createMessage(params);
    assert.equal(msg.id, 'from-openai');
    assert.equal(secondCalled, false);
  });

  it('fails over to the next provider when the first throws', async () => {
    const c = new FallbackMessageClient(
      [link('openai', fail('429 rate limit')), link('anthropic', ok('from-anthropic'))],
      noopLogger,
    );
    const msg = await c.createMessage(params);
    assert.equal(msg.id, 'from-anthropic');
  });

  it('throws the last error when every provider fails', async () => {
    const c = new FallbackMessageClient(
      [link('openai', fail('openai down')), link('anthropic', fail('anthropic down'))],
      noopLogger,
    );
    await assert.rejects(c.createMessage(params), /anthropic down/);
  });

  it('does NOT fail over on a user abort — it rethrows immediately', async () => {
    let secondCalled = false;
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const c = new FallbackMessageClient(
      [link('openai', abort), link('anthropic', async () => { secondCalled = true; return {} as never; })],
      noopLogger,
    );
    await assert.rejects(c.createMessage(params), /aborted/);
    assert.equal(secondCalled, false);
  });

  it('does NOT fail over once text has streamed to the user (would duplicate output)', async () => {
    let secondCalled = false;
    const streamThenFail: MessageClient['createMessage'] = async (p) => {
      p.onText?.('partial answer');
      throw new Error('died mid-stream');
    };
    const c = new FallbackMessageClient(
      [link('openai', streamThenFail), link('anthropic', async () => { secondCalled = true; return {} as never; })],
      noopLogger,
    );
    const seen: string[] = [];
    await assert.rejects(
      c.createMessage({ onText: (d: string) => seen.push(d) } as CreateMessageParams),
      /died mid-stream/,
    );
    assert.equal(secondCalled, false);
    assert.deepEqual(seen, ['partial answer']);
  });
});
