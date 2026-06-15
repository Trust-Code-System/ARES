/**
 * Per-turn model selection (the HUD model switch) — offline.
 *
 * Covers the pure {@link parseModelChoice} parser and the orchestrator wiring:
 * `Auto` classifies a turn and picks the tier (chat → fast path, SIMPLE → fast
 * tier, COMPLEX → reasoning); an explicit choice forces the tier and, with a
 * router, switches provider. No network or real model calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';

import { Agent, type MessageClient } from '../src/agent/orchestrator.js';
import { parseModelChoice } from '../src/llm/modelChoice.js';
import { ModelRouter, type Provider } from '../src/llm/router.js';
import type { LlmRuntime } from '../src/llm/factory.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ConfirmationGate, Logger, MemoryRetriever } from '../src/types.js';

describe('parseModelChoice', () => {
  it('treats empty/unknown/auto as auto', () => {
    for (const raw of [undefined, '', 'auto', 'nonsense', 'claude', 'fooprovider:fast']) {
      assert.deepEqual(parseModelChoice(raw), { mode: 'auto' });
    }
  });

  it('maps fast/smart shorthands to the default provider tiers', () => {
    assert.deepEqual(parseModelChoice('fast'), { mode: 'explicit', tier: 'fast' });
    assert.deepEqual(parseModelChoice('smart'), { mode: 'explicit', tier: 'reasoning' });
    assert.deepEqual(parseModelChoice('reasoning'), { mode: 'explicit', tier: 'reasoning' });
  });

  it('parses <provider>:<tier> (defaulting an unknown tier to reasoning)', () => {
    assert.deepEqual(parseModelChoice('openai:fast'), { mode: 'explicit', provider: 'openai', tier: 'fast' });
    assert.deepEqual(parseModelChoice('GEMINI:REASONING'), { mode: 'explicit', provider: 'gemini', tier: 'reasoning' });
    assert.deepEqual(parseModelChoice('anthropic:weird'), { mode: 'explicit', provider: 'anthropic', tier: 'reasoning' });
  });
});

describe('orchestrator — Auto tier selection', () => {
  it('runs a SIMPLE task on the fast tier', async () => {
    const client = new RecordingClient(['SIMPLE', 'quick answer']);
    const agent = makeAgent({ client, enableFastChat: true });

    const result = await agent.run({ text: 'what is the capital of France', source: 'user' });

    assert.ok(!result.fastChat); // it's a task, not the fast-chat path
    assert.match(result.finalText, /quick answer/);
    // First call is the classifier (fast); the task loop is the last call.
    assert.equal(client.tiers.at(-1), 'fast');
  });

  it('runs a COMPLEX task on the reasoning tier', async () => {
    const client = new RecordingClient(['COMPLEX', 'considered answer']);
    const agent = makeAgent({ client, enableFastChat: true });

    const result = await agent.run({ text: 'design a distributed rate limiter', source: 'user' });

    assert.match(result.finalText, /considered answer/);
    assert.equal(client.tiers.at(-1), 'reasoning');
  });
});

describe('orchestrator — explicit model choice', () => {
  it('forces the fast tier without a classifier round-trip', async () => {
    // Only ONE response: a classifier call would have no mock and throw, so the
    // single response being consumed as the answer proves the classifier was skipped.
    const client = new RecordingClient(['forced fast']);
    let memoryCalls = 0;
    const memory: MemoryRetriever = { async retrieve() { memoryCalls += 1; return ''; } };
    const agent = makeAgent({ client, memory, enableFastChat: true });

    const result = await agent.run({ text: 'hello there', source: 'user', model: 'fast' });

    assert.match(result.finalText, /forced fast/);
    assert.equal(client.tiers.length, 1);
    assert.equal(client.tiers[0], 'fast');
    assert.equal(memoryCalls, 1); // full agent path, not fast-chat
  });

  it('switches provider through the router when one is named', async () => {
    const defaultClient = new RecordingClient(['should not run']);
    const openaiClient = new RecordingClient(['openai answer']);
    const router = new ModelRouter(
      new Map<Provider, LlmRuntime>([
        ['anthropic', runtimeFor('anthropic', defaultClient)],
        ['openai', runtimeFor('openai', openaiClient)],
      ]),
      'anthropic',
    );
    const agent = makeAgent({ client: defaultClient, router, enableFastChat: true });

    const result = await agent.run({ text: 'summarize this', source: 'user', model: 'openai:reasoning' });

    assert.match(result.finalText, /openai answer/);
    assert.equal(defaultClient.tiers.length, 0); // never touched the default provider
    assert.equal(openaiClient.tiers.at(-1), 'reasoning');
  });
});

/** A MessageClient that records the tier of each call and replays a scripted answer. */
class RecordingClient implements MessageClient {
  readonly tiers: string[] = [];
  constructor(private readonly script: string[]) {}
  async createMessage(params: { tier?: string }): Promise<Anthropic.Message> {
    this.tiers.push(params.tier ?? 'reasoning');
    const text = this.script.shift();
    if (text === undefined) throw new Error('No mock response configured');
    return message('end_turn', [{ type: 'text', text } as Anthropic.ContentBlock]);
  }
}

function runtimeFor(provider: Provider, client: MessageClient): LlmRuntime {
  return {
    client,
    provider,
    reasoningModel: `${provider}-reasoning`,
    fastModel: `${provider}-fast`,
  };
}

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

function makeAgent(overrides: {
  client: MessageClient;
  memory?: MemoryRetriever;
  router?: ModelRouter;
  enableFastChat?: boolean;
}): Agent {
  const memory: MemoryRetriever = overrides.memory ?? { async retrieve() { return ''; } };
  const gate: ConfirmationGate = { async requestApproval() { return { approved: false, reason: 'test deny' }; } };
  return new Agent({
    client: overrides.client,
    ...(overrides.router ? { router: overrides.router } : {}),
    registry: new ToolRegistry(),
    gate,
    memory,
    logger,
    audit: new InMemoryAuditLog(),
    systemPrompt: 'test',
    maxIterations: 2,
    enableFastChat: overrides.enableFastChat ?? false,
  });
}

function message(
  stopReason: Anthropic.Message['stop_reason'],
  content: Anthropic.Message['content'],
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}
