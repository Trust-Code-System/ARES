/**
 * Zod-first tool definitions + validation. Offline and deterministic:
 *   - defineTool/zodInputSchema produce the Anthropic strict-mode JSON shape.
 *   - the orchestrator validates a tool's input against its Zod schema, rejecting
 *     malformed arguments before the tool runs (and passing parsed data when valid).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { defineTool, zodInputSchema, formatZodError } from '../src/tools/define.js';
import { Agent, type MessageClient } from '../src/agent/orchestrator.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import type { ConfirmationGate, Logger, MemoryRetriever } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

describe('zodInputSchema', () => {
  it('produces the Anthropic strict-mode shape and strips $schema', () => {
    const schema = zodInputSchema(
      z.object({
        path: z.string().describe('a path'),
        urgency: z.enum(['low', 'high']).optional(),
      }),
    ) as Record<string, unknown>;

    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['path']); // optional field omitted
    assert.equal('$schema' in schema, false);
    const props = schema.properties as Record<string, { description?: string; enum?: string[] }>;
    assert.equal(props.path!.description, 'a path');
    assert.deepEqual(props.urgency!.enum, ['low', 'high']);
  });
});

describe('formatZodError', () => {
  it('renders issues as "path: message" joined by semicolons', () => {
    const result = z.object({ a: z.string(), n: z.number() }).safeParse({ n: 'x' });
    assert.equal(result.success, false);
    const text = formatZodError(result.error);
    assert.match(text, /a:/);
    assert.match(text, /n:/);
    assert.match(text, /;/);
  });
});

describe('defineTool', () => {
  it('attaches both the derived JSON schema and the Zod schema', () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      kind: 'read_only',
      schema: z.object({ msg: z.string() }),
      async execute(input) {
        return { ok: true, content: input.msg };
      },
    });
    assert.ok(tool.inputZod, 'inputZod should be set');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.required, ['msg']);
  });
});

// --- Orchestrator-level validation ----------------------------------------

class SequenceClient implements MessageClient {
  private i = 0;
  constructor(private readonly responses: Anthropic.Message[]) {}
  async createMessage(): Promise<Anthropic.Message> {
    return this.responses[this.i++]!;
  }
}

function message(stop: Anthropic.Message['stop_reason'], content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: 'msg', type: 'message', role: 'assistant', model: 'test',
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  };
}

function toolUse(name: string, input: unknown): Anthropic.ContentBlock {
  return { type: 'tool_use', id: 'toolu_1', name, input } as Anthropic.ToolUseBlock;
}

const autoGate: ConfirmationGate = { async requestApproval() { return { approved: true, reason: 'auto' }; } };
const noMemory: MemoryRetriever = { async retrieve() { return ''; } };

function makeAgent(client: MessageClient, registry: ToolRegistry, audit: InMemoryAuditLog) {
  return new Agent({
    client, registry, gate: autoGate, memory: noMemory, logger, audit,
    systemPrompt: 'test', maxIterations: 4,
  });
}

describe('orchestrator Zod validation', () => {
  it('rejects malformed tool input via the Zod schema before executing', async () => {
    let executed = false;
    const tool = defineTool({
      name: 'set_count',
      description: 'set a count',
      kind: 'read_only',
      schema: z.object({ count: z.number() }),
      async execute() { executed = true; return { ok: true, content: 'ok' }; },
    });
    const registry = new ToolRegistry().register(tool);
    const audit = new InMemoryAuditLog();
    const client = new SequenceClient([
      message('tool_use', [toolUse('set_count', { count: 'not-a-number' })]),
      message('end_turn', [{ type: 'text', text: 'done' }]),
    ]);

    const result = await makeAgent(client, registry, audit).run({ text: 'go', source: 'user' });

    assert.equal(executed, false, 'execute must not run on invalid input');
    assert.deepEqual(result.toolCalls, [{ name: 'set_count', ok: false }]);
    const failed = audit.forRun(result.runId).find((e) => e.type === 'tool_failed');
    assert.ok(failed);
    assert.equal(failed!.detail.error, 'invalid arguments');
  });

  it('passes parsed, schema-valid input to the tool', async () => {
    let seen: unknown;
    const tool = defineTool({
      name: 'set_count',
      description: 'set a count',
      kind: 'read_only',
      schema: z.object({ count: z.number() }),
      async execute(input) { seen = input; return { ok: true, content: String(input.count) }; },
    });
    const registry = new ToolRegistry().register(tool);
    const audit = new InMemoryAuditLog();
    const client = new SequenceClient([
      message('tool_use', [toolUse('set_count', { count: 42 })]),
      message('end_turn', [{ type: 'text', text: 'done' }]),
    ]);

    const result = await makeAgent(client, registry, audit).run({ text: 'go', source: 'user' });

    assert.deepEqual(seen, { count: 42 });
    assert.deepEqual(result.toolCalls, [{ name: 'set_count', ok: true }]);
  });
});
