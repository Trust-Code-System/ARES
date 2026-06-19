/**
 * OpenAI Responses API adapter for the existing ARES agent loop.
 *
 * The orchestrator intentionally speaks the Anthropic message shape internally.
 * This adapter translates that shape at the provider boundary so tool gating,
 * memory, audit logging, and the manual reason/act loop remain provider-neutral.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ToolChoiceFunction,
} from 'openai/resources/responses/responses';
import type { CreateMessageParams, ModelTier } from './anthropic.js';
import { redactSensitiveData, redactSensitiveText } from '../security/redactor.js';

export interface OpenAIResponsesClientOptions {
  apiKey: string;
  reasoningModel: string;
  fastModel: string;
  baseUrl?: string;
  /** Injectable for deterministic unit tests. */
  sdk?: OpenAI;
}

interface CachedOutput {
  responseId: string;
  items: ResponseOutputItem[];
}

export class OpenAIResponsesClient {
  private readonly sdk: OpenAI;
  private readonly models: Record<ModelTier, string>;
  private readonly outputByCallId = new Map<string, CachedOutput>();

  constructor(opts: OpenAIResponsesClientOptions) {
    this.sdk = opts.sdk ?? new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    this.models = { reasoning: opts.reasoningModel, fast: opts.fastModel };
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async createMessage(params: CreateMessageParams): Promise<Anthropic.Message> {
    const tier = params.tier ?? 'reasoning';
    const body: ResponseCreateParamsNonStreaming = {
      model: this.models[tier],
      instructions: redactSensitiveText(params.system),
      input: this.toOpenAIInput(redactSensitiveData(params.messages)),
      tools: params.tools.map(toOpenAITool),
      tool_choice: toOpenAIToolChoice(params.toolChoice),
      max_output_tokens: params.maxTokens ?? 16000,
      reasoning: { effort: reasoningEffort(params, tier) },
      text: { verbosity: tier === 'fast' ? 'low' : 'medium' },
      include: ['reasoning.encrypted_content'],
      store: false,
      parallel_tool_calls: false,
    };
    const options = params.signal ? { signal: params.signal } : undefined;

    let response: Response;
    if (!params.onText) {
      response = await this.sdk.responses.create(body, options);
    } else {
      const streamBody: ResponseCreateParamsStreaming = { ...body, stream: true };
      const stream = await this.sdk.responses.create(streamBody, options);
      let completed: Response | undefined;
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') params.onText(event.delta);
        if (event.type === 'response.completed') completed = event.response;
        if (event.type === 'response.failed') {
          throw new Error(event.response.error?.message ?? 'OpenAI response failed');
        }
        if (event.type === 'error') throw new Error(event.message);
      }
      if (!completed) throw new Error('OpenAI stream ended without a completed response');
      response = completed;
    }

    this.cacheOutput(response);
    return toAnthropicMessage(response);
  }

  private toOpenAIInput(messages: Anthropic.MessageParam[]): ResponseInput {
    const input: ResponseInputItem[] = [];
    const replayedResponses = new Set<string>();

    for (const message of messages) {
      if (typeof message.content === 'string') {
        input.push({ type: 'message', role: message.role, content: message.content });
        continue;
      }

      if (message.role === 'assistant') {
        const toolUses = message.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );
        const cached = toolUses
          .map((block) => this.outputByCallId.get(block.id))
          .find((value): value is CachedOutput => Boolean(value));
        if (cached && !replayedResponses.has(cached.responseId)) {
          input.push(...cached.items as ResponseInputItem[]);
          replayedResponses.add(cached.responseId);
          continue;
        }

        const text = message.content
          .filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        if (text) input.push({ type: 'message', role: 'assistant', content: text, phase: 'commentary' });
        for (const use of toolUses) {
          input.push({
            type: 'function_call',
            call_id: use.id,
            name: use.name,
            arguments: JSON.stringify(use.input),
          });
        }
        continue;
      }

      for (const block of message.content) {
        if (block.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: toolResultText(block.content),
          });
        } else if (block.type === 'text') {
          input.push({ type: 'message', role: 'user', content: block.text });
        }
      }
    }

    return input;
  }

  private cacheOutput(response: Response): void {
    const calls = response.output.filter(
      (item): item is Extract<ResponseOutputItem, { type: 'function_call' }> =>
        item.type === 'function_call',
    );
    if (calls.length === 0) return;
    const cached = { responseId: response.id, items: response.output };
    for (const call of calls) this.outputByCallId.set(call.call_id, cached);
  }
}

function toOpenAITool(tool: Anthropic.Tool): FunctionTool {
  const parameters = tool.input_schema as Record<string, unknown>;
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters,
    strict: (tool.strict ?? true) && isOpenAIStrictCompatible(parameters),
  };
}

/**
 * OpenAI strict mode requires every object property to be required and forbids
 * additional properties. ARES tools may intentionally expose optional inputs,
 * so those schemas must use the provider's non-strict mode.
 */
function isOpenAIStrictCompatible(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  const value = schema as Record<string, unknown>;

  if (value.type === 'object') {
    const properties = value.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
    if (value.additionalProperties !== false) return false;

    const propertyNames = Object.keys(properties);
    const required = Array.isArray(value.required)
      ? value.required.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (
      required.length !== propertyNames.length ||
      propertyNames.some((name) => !required.includes(name))
    ) return false;

    return Object.values(properties).every(isOpenAIStrictCompatible);
  }

  if (value.type === 'array') return isOpenAIStrictCompatible(value.items);
  if (Array.isArray(value.anyOf)) return value.anyOf.every(isOpenAIStrictCompatible);
  if (Array.isArray(value.oneOf)) return value.oneOf.every(isOpenAIStrictCompatible);
  return true;
}

function toOpenAIToolChoice(
  choice: Anthropic.MessageCreateParams['tool_choice'] | undefined,
): 'auto' | 'none' | 'required' | ToolChoiceFunction | undefined {
  if (!choice) return 'auto';
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') return { type: 'function', name: choice.name };
  return 'auto';
}

function reasoningEffort(
  params: CreateMessageParams,
  tier: ModelTier,
): 'none' | 'low' | 'medium' {
  if (params.thinking?.type === 'disabled') return 'none';
  return tier === 'fast' ? 'low' : 'medium';
}

function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((block) => block.type === 'text' ? block.text : JSON.stringify(block))
    .join('\n');
}

function toAnthropicMessage(response: Response): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  let refused = false;

  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          content.push({ type: 'text', text: part.text, citations: null });
        } else if (part.type === 'refusal') {
          refused = true;
          content.push({ type: 'text', text: part.refusal, citations: null });
        }
      }
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parseArguments(item.arguments),
        caller: { type: 'direct' },
      });
    }
  }

  const hasToolCall = content.some((block) => block.type === 'tool_use');
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: String(response.model),
    content,
    stop_reason: refused ? 'refusal' : hasToolCall ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: response.usage?.input_tokens_details.cached_tokens ?? null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
    },
  } as Anthropic.Message;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
