import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent, type MessageClient } from '../src/agent/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { BasicConfirmationGate } from '../src/tools/confirmation.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type {
  ConfirmationGate,
  Logger,
  MemoryRetriever,
  Tool,
  ToolResult,
} from '../src/types.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const logger: Logger = {
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('configuration', () => {
  it('rejects an invalid iteration cap', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ARES_MAX_ITERATIONS = '0';

    assert.throws(loadConfig, /integer from 1 to 100/);
  });
});

describe('confirmation gate', () => {
  it('uses an injected prompt so the REPL can own stdin', async () => {
    let question = '';
    const gate = new BasicConfirmationGate('prompt', logger, async (value) => {
      question = value;
      return 'yes';
    });

    const decision = await gate.requestApproval({
      tool: makeTool('state_mutating'),
      input: { value: 1 },
      runId: 'run-1',
    });

    assert.equal(decision.approved, true);
    assert.match(question, /approve/);
  });
});

describe('tool registry', () => {
  it('enables strict schema conformance for Anthropic tool calls', () => {
    const [schema] = new ToolRegistry().register(makeTool('read_only')).toAnthropicTools();
    assert.equal(schema?.strict, true);
  });
});

describe('audit log', () => {
  it('does not expose mutable references to recorded event details', () => {
    const audit = new InMemoryAuditLog();
    const detail = { nested: { value: 1 } };
    audit.record({
      runId: 'run-1',
      ts: new Date().toISOString(),
      type: 'run_started',
      detail,
    });

    detail.nested.value = 2;
    const firstRead = audit.forRun('run-1');
    (firstRead[0]!.detail.nested as { value: number }).value = 3;

    assert.deepEqual(audit.forRun('run-1')[0]!.detail, { nested: { value: 1 } });
  });
});

describe('agent lifecycle', () => {
  it('never executes a state-mutating tool when confirmation is denied', async () => {
    let executed = false;
    const tool = makeTool('state_mutating', async () => {
      executed = true;
      return { ok: true, content: 'executed' };
    });
    const registry = new ToolRegistry().register(tool);
    const client = new SequenceClient([
      message('tool_use', [
        {
          type: 'tool_use',
          id: 'toolu_test',
          name: tool.name,
          input: {},
        },
      ]),
      message('end_turn', [{ type: 'text', text: 'The action was not approved.' }]),
    ]);
    const gate: ConfirmationGate = {
      async requestApproval() {
        return { approved: false, reason: 'test deny' };
      },
    };
    const agent = makeAgent({ client, registry, gate });

    const result = await agent.run({ text: 'run the tool', source: 'user' });

    assert.equal(executed, false);
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.toolCalls, [{ name: tool.name, ok: false }]);
  });

  it('turns memory retrieval failures into an audited error result', async () => {
    const audit = new InMemoryAuditLog();
    const memory: MemoryRetriever = {
      async retrieve() {
        throw new Error('memory unavailable');
      },
    };
    const agent = makeAgent({
      client: new SequenceClient([]),
      memory,
      audit,
    });

    const result = await agent.run({ text: 'hello', source: 'user' });

    assert.equal(result.stopReason, 'error');
    assert.deepEqual(
      audit.forRun(result.runId).map((event) => event.type),
      ['run_started', 'error', 'run_finished'],
    );
  });

  it('reports API cancellation as aborted rather than error', async () => {
    const controller = new AbortController();
    const client: MessageClient = {
      async createMessage() {
        controller.abort();
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      },
    };
    const audit = new InMemoryAuditLog();
    const agent = makeAgent({ client, audit });

    const result = await agent.run(
      { text: 'hello', source: 'user' },
      controller.signal,
    );

    assert.equal(result.stopReason, 'aborted');
    assert.equal(audit.forRun(result.runId).some((event) => event.type === 'error'), false);
  });

  it('forwards live text and audit events without changing the final result', async () => {
    const client: MessageClient = {
      async createMessage(params) {
        params.onText?.('live ');
        params.onText?.('answer');
        return message('end_turn', [{ type: 'text', text: 'live answer' }]);
      },
    };
    const agent = makeAgent({ client });
    const tokens: string[] = [];
    const eventTypes: string[] = [];

    const result = await agent.run(
      { text: 'hello', source: 'user' },
      undefined,
      {
        onText: (token) => tokens.push(token),
        onAudit: (event) => eventTypes.push(event.type),
      },
    );

    assert.equal(result.finalText, 'live answer');
    assert.deepEqual(tokens, ['live ', 'answer']);
    assert.deepEqual(eventTypes, ['run_started', 'model_response', 'run_finished']);
  });

  it('does not execute a tool that was disabled after registration', async () => {
    let executed = false;
    const tool = makeTool('read_only', async () => {
      executed = true;
      return { ok: true, content: 'executed' };
    });
    const registry = new ToolRegistry().register(tool);
    registry.setEnabled(tool.name, false);
    const client = new SequenceClient([
      message('tool_use', [
        {
          type: 'tool_use',
          id: 'toolu_disabled',
          name: tool.name,
          input: {},
        },
      ]),
      message('end_turn', [{ type: 'text', text: 'The tool is disabled.' }]),
    ]);
    const agent = makeAgent({ client, registry });

    const result = await agent.run({ text: 'run the disabled tool', source: 'user' });

    assert.equal(executed, false);
    assert.deepEqual(result.toolCalls, [{ name: tool.name, ok: false }]);
  });
});

class SequenceClient implements MessageClient {
  constructor(private readonly responses: Anthropic.Message[]) {}

  async createMessage(): Promise<Anthropic.Message> {
    const response = this.responses.shift();
    if (!response) throw new Error('No mock response configured');
    return response;
  }
}

function makeAgent(overrides: {
  client?: MessageClient;
  memory?: MemoryRetriever;
  audit?: InMemoryAuditLog;
  registry?: ToolRegistry;
  gate?: ConfirmationGate;
}): Agent {
  const memory: MemoryRetriever = overrides.memory ?? {
    async retrieve() {
      return '';
    },
  };
  const gate: ConfirmationGate = overrides.gate ?? {
    async requestApproval() {
      return { approved: false, reason: 'test deny' };
    },
  };

  return new Agent({
    client: overrides.client ?? new SequenceClient([]),
    registry: overrides.registry ?? new ToolRegistry(),
    gate,
    memory,
    logger,
    audit: overrides.audit ?? new InMemoryAuditLog(),
    systemPrompt: 'test',
    maxIterations: 2,
  });
}

function makeTool(
  kind: Tool['kind'],
  execute: Tool['execute'] = async () => ({ ok: true, content: 'ok' }),
): Tool {
  return {
    name: 'test_tool',
    description: 'Test tool.',
    kind,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute,
  };
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
