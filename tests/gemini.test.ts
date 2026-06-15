import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { GeminiClient } from '../src/llm/gemini.js';

describe('GeminiClient', () => {
  it('maps function calls and replays ids plus thought signatures with results', async () => {
    const requests: GenerateContentParameters[] = [];
    const queue = [
      {
        responseId: 'gemini-1',
        modelVersion: 'gemini-3.5-flash',
        candidates: [{
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{
              thoughtSignature: 'opaque-signature',
              functionCall: {
                id: 'call-1',
                name: 'calculate',
                args: { expression: '6*7' },
              },
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
      {
        responseId: 'gemini-2',
        modelVersion: 'gemini-3.5-flash',
        candidates: [{
          finishReason: 'STOP',
          content: { role: 'model', parts: [{ text: '42' }] },
        }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 },
      },
    ] as GenerateContentResponse[];
    const sdk = {
      models: {
        async generateContent(params: GenerateContentParameters) {
          requests.push(params);
          return queue.shift()!;
        },
        async generateContentStream() {
          throw new Error('not used');
        },
      },
    };
    const client = new GeminiClient({
      apiKey: 'test',
      reasoningModel: 'gemini-3.5-flash',
      fastModel: 'gemini-3.1-flash-lite',
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
    }];

    const call = await client.createMessage({
      system: 'You are ARES.',
      messages: [{ role: 'user', content: 'Calculate 6*7' }],
      tools,
    });
    const use = call.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    assert.equal(use?.id, 'call-1');
    assert.equal(use?.name, 'calculate');
    assert.deepEqual(use?.input, { expression: '6*7' });

    const answer = await client.createMessage({
      system: 'You are ARES.',
      messages: [
        { role: 'user', content: 'Calculate 6*7' },
        { role: 'assistant', content: call.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: '42',
          }],
        },
      ],
      tools,
    });

    assert.equal((answer.content[0] as Anthropic.TextBlock).text, '42');
    const history = requests[1]!.contents as Array<{
      role?: string;
      parts?: Array<{
        thoughtSignature?: string;
        functionCall?: { id?: string };
        functionResponse?: { id?: string; name?: string };
      }>;
    }>;
    assert.equal(history[1]?.parts?.[0]?.thoughtSignature, 'opaque-signature');
    assert.equal(history[1]?.parts?.[0]?.functionCall?.id, 'call-1');
    assert.equal(history[2]?.parts?.[0]?.functionResponse?.id, 'call-1');
    assert.equal(history[2]?.parts?.[0]?.functionResponse?.name, 'calculate');
  });
});
