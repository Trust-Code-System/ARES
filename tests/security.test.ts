import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent, type MessageClient } from '../src/agent/orchestrator.js';
import type { CreateMessageParams } from '../src/llm/anthropic.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { HashEmbeddingClient } from '../src/memory/embeddings.js';
import { MemoryIngestor } from '../src/memory/ingestor.js';
import { InMemorySemanticStore, InMemoryStructuredStore } from '../src/memory/stores.js';
import { createMemoryTools } from '../src/tools/builtin/memory.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { redactSensitiveData, redactSensitiveText } from '../src/security/redactor.js';
import type { Logger, MemoryRetriever, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

describe('secret safety layer', () => {
  it('redacts common authentication secrets in text and objects', () => {
    assert.equal(redactSensitiveText('my password is hunter2'), 'my password: [REDACTED]');
    assert.equal(redactSensitiveText('Authorization: Bearer abc.def.ghi'), 'Authorization: [REDACTED]');
    assert.equal(redactSensitiveText('otp 123456'), 'otp [REDACTED]');

    const redacted = redactSensitiveData({
      email: 'user@example.com',
      password: 'hunter2',
      field: { label: 'OTP', value: '123456' },
      nested: { cookie: 'sid=secret' },
    });
    assert.deepEqual(redacted, {
      email: 'user@example.com',
      password: '[REDACTED]',
      field: { label: 'OTP', value: '[REDACTED]' },
      nested: { cookie: '[REDACTED]' },
    });
  });

  it('redacts audit events before storage', () => {
    const audit = new InMemoryAuditLog();
    audit.record({
      runId: 'r1',
      ts: new Date().toISOString(),
      type: 'tool_requested',
      detail: { tool: 'login', input: { username: 'me', password: 'hunter2' } },
    });
    const stored = audit.forRun('r1')[0]!;
    assert.equal(JSON.stringify(stored).includes('hunter2'), false);
    assert.equal((stored.detail.input as { password: string }).password, '[REDACTED]');
  });

  it('does not send raw user secrets to the model', async () => {
    const client = new RecordingClient(message('end_turn', [{ type: 'text', text: 'done' }]));
    const agent = new Agent({
      client,
      registry: new ToolRegistry(),
      gate: { async requestApproval() { return { approved: true, reason: 'test' }; } },
      memory: { async retrieve() { return ''; } } satisfies MemoryRetriever,
      logger,
      audit: new InMemoryAuditLog(),
      systemPrompt: 'test',
      maxIterations: 2,
    });

    await agent.run({
      text: 'my password is hunter2',
      source: 'user',
      history: [{ role: 'user', content: 'otp 123456' }],
    });

    const payload = JSON.stringify(client.calls);
    assert.equal(payload.includes('hunter2'), false);
    assert.equal(payload.includes('123456'), false);
    assert.match(payload, /\[REDACTED\]/);
  });

  it('refuses explicit memory writes that contain secrets', async () => {
    const store = new InMemoryStructuredStore();
    const remember = createMemoryTools(store).find((tool) => tool.name === 'remember_memory')!;
    const ctx: ToolContext = { logger, runId: 'r-memory' };
    const result = await remember.execute({
      kind: 'fact',
      subject: 'user',
      content: 'my password is hunter2',
    }, ctx);

    assert.equal(result.ok, false);
    assert.match(result.content, /does not store passwords/);
    assert.equal((await store.all()).length, 0);
  });

  it('redacts secrets before semantic memory embedding/storage and drops extracted secret facts', async () => {
    const semantic = new InMemorySemanticStore();
    const structured = new InMemoryStructuredStore();
    const ingestor = new MemoryIngestor({
      client: new RecordingClient(message('tool_use', [{
        type: 'tool_use',
        id: 'toolu_1',
        name: 'record_memory',
        input: { facts: [{ kind: 'fact', subject: 'user', content: 'password is hunter2' }] },
      }])),
      embeddings: new HashEmbeddingClient(128),
      semantic,
      structured,
      logger,
    });

    await ingestor.ingest({
      runId: 'r-ingest',
      source: 'user',
      userText: 'my password is hunter2',
      assistantText: 'Noted.',
    });

    assert.equal((await structured.all()).length, 0);
    const [embedding] = await new HashEmbeddingClient(128).embed(['password'], 'query');
    const hits = await semantic.search(embedding!, 5, 0);
    assert.ok(hits.length > 0);
    assert.equal(JSON.stringify(hits).includes('hunter2'), false);
  });
});

class RecordingClient implements MessageClient {
  readonly calls: CreateMessageParams[] = [];
  constructor(private readonly response: Anthropic.Message) {}

  async createMessage(params: CreateMessageParams): Promise<Anthropic.Message> {
    this.calls.push(params);
    return this.response;
  }
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
      cache_creation: null,
      inference_geo: null,
      iterations: [],
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
}
