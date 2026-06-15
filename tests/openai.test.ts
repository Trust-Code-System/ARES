import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParams,
} from 'openai/resources/responses/responses';
import { OpenAIResponsesClient } from '../src/llm/openai.js';

function response(
  id: string,
  output: Response['output'],
  outputText = '',
): Response {
  return {
    id,
    created_at: 0,
    output_text: outputText,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5.5',
    object: 'response',
    output,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    background: false,
    completed_at: 0,
    conversation: null,
    max_output_tokens: 100,
    max_tool_calls: null,
    previous_response_id: null,
    prompt: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: 'default',
    status: 'completed',
    text: { format: { type: 'text' } },
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  } as Response;
}

describe('OpenAIResponsesClient', () => {
  it('maps OpenAI function calls into the existing ARES tool-use loop and replays them with results', async () => {
    const requests: ResponseCreateParams[] = [];
    const first = response('resp-1', [
      {
        id: 'reason-1',
        type: 'reasoning',
        summary: [],
        encrypted_content: 'encrypted',
        status: 'completed',
      },
      {
        id: 'fc-1',
        type: 'function_call',
        call_id: 'call-1',
        name: 'calculate',
        arguments: '{"expression":"2+2"}',
        status: 'completed',
      },
    ]);
    const second = response('resp-2', [
      {
        id: 'msg-2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: '4', annotations: [] }],
      },
    ], '4');
    const queue = [first, second];
    const sdk = {
      responses: {
        async create(body: ResponseCreateParams) {
          requests.push(body);
          return queue.shift()!;
        },
      },
    } as unknown as OpenAI;
    const client = new OpenAIResponsesClient({
      apiKey: 'test',
      reasoningModel: 'gpt-5.5',
      fastModel: 'gpt-5.4-mini',
      sdk,
    });
    const tools: Anthropic.Tool[] = [{
      name: 'calculate',
      description: 'Do math',
      input_schema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
        additionalProperties: false,
      },
      strict: true,
    }];

    const toolMessage = await client.createMessage({
      system: 'You are ARES.',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      tools,
    });
    const toolUse = toolMessage.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    assert.equal(toolMessage.stop_reason, 'tool_use');
    assert.equal(toolUse?.name, 'calculate');
    assert.deepEqual(toolUse?.input, { expression: '2+2' });
    const sentTools = requests[0]!.tools as Array<{ name: string; strict?: boolean }>;
    assert.equal(sentTools[0]?.strict, true);

    const finalMessage = await client.createMessage({
      system: 'You are ARES.',
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: toolMessage.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: '4',
          }],
        },
      ],
      tools,
    });

    assert.equal(finalMessage.stop_reason, 'end_turn');
    assert.equal((finalMessage.content[0] as Anthropic.TextBlock).text, '4');
    const replay = requests[1]!.input as Array<{ type?: string; call_id?: string }>;
    assert.ok(replay.some((item) => item.type === 'reasoning'));
    assert.ok(replay.some((item) => item.type === 'function_call' && item.call_id === 'call-1'));
    assert.ok(replay.some((item) => item.type === 'function_call_output' && item.call_id === 'call-1'));
  });

  it('disables OpenAI strict mode for schemas with optional properties', async () => {
    let request: ResponseCreateParams | undefined;
    const sdk = {
      responses: {
        async create(body: ResponseCreateParams) {
          request = body;
          return response('resp-optional', [{
            id: 'msg-optional',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Done', annotations: [] }],
          }]);
        },
      },
    } as unknown as OpenAI;
    const client = new OpenAIResponsesClient({
      apiKey: 'test',
      reasoningModel: 'gpt-5.5',
      fastModel: 'gpt-5.4-mini',
      sdk,
    });

    await client.createMessage({
      system: 'You are ARES.',
      messages: [{ role: 'user', content: 'What time is it?' }],
      tools: [{
        name: 'get_current_time',
        description: 'Get the current time',
        input_schema: {
          type: 'object',
          properties: { timezone: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
        strict: true,
      }],
    });

    const sentTools = request!.tools as Array<{ name: string; strict?: boolean }>;
    assert.equal(sentTools[0]?.strict, false);
  });
});
