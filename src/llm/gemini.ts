/**
 * Gemini generateContent adapter for the provider-neutral ARES agent loop.
 *
 * ARES keeps Anthropic-shaped messages internally because the orchestrator and
 * audit path predate multi-provider support. This boundary translates messages,
 * tools, function results, streaming text, and Gemini thought signatures.
 */

import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import type { CreateMessageParams, ModelTier } from './anthropic.js';
import { redactSensitiveData, redactSensitiveText } from '../security/redactor.js';

interface GeminiSdk {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

export interface GeminiClientOptions {
  apiKey: string;
  reasoningModel: string;
  fastModel: string;
  /** Injectable for deterministic tests. */
  sdk?: GeminiSdk;
}

interface CachedContent {
  responseId: string;
  content: Content;
}

export class GeminiClient {
  private readonly sdk: GeminiSdk;
  private readonly models: Record<ModelTier, string>;
  private readonly contentByCallId = new Map<string, CachedContent>();
  private readonly callNames = new Map<string, string>();

  constructor(opts: GeminiClientOptions) {
    this.sdk = opts.sdk ?? new GoogleGenAI({ apiKey: opts.apiKey });
    this.models = { reasoning: opts.reasoningModel, fast: opts.fastModel };
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async createMessage(params: CreateMessageParams): Promise<Anthropic.Message> {
    const tier = params.tier ?? 'reasoning';
    const request: GenerateContentParameters = {
      model: this.models[tier],
      contents: this.toGeminiContents(redactSensitiveData(params.messages)),
      config: {
        systemInstruction: redactSensitiveText(params.system),
        maxOutputTokens: params.maxTokens ?? 16000,
        tools: params.tools.length
          ? [{
              functionDeclarations: params.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.input_schema,
              })),
            }]
          : undefined,
        toolConfig: params.tools.length ? toToolConfig(params.toolChoice) : undefined,
        automaticFunctionCalling: { disable: true },
        thinkingConfig: {
          thinkingBudget: params.thinking?.type === 'disabled' ? 0 : -1,
          includeThoughts: false,
        },
        abortSignal: params.signal,
      },
    };

    if (!params.onText) {
      const response = await this.sdk.models.generateContent(request);
      return this.toAnthropicMessage(response, tier);
    }

    const stream = await this.sdk.models.generateContentStream(request);
    const parts: Part[] = [];
    let finalChunk: GenerateContentResponse | undefined;
    for await (const chunk of stream) {
      finalChunk = chunk;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        parts.push(part);
        if (part.text && !part.thought) params.onText(part.text);
      }
    }
    if (!finalChunk) throw new Error('Gemini stream ended without a response');

    const response = {
      responseId: finalChunk.responseId,
      modelVersion: finalChunk.modelVersion,
      usageMetadata: finalChunk.usageMetadata,
      candidates: [{
        ...finalChunk.candidates?.[0],
        content: { role: 'model', parts },
      }],
    } as GenerateContentResponse;
    return this.toAnthropicMessage(response, tier);
  }

  private toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
    const contents: Content[] = [];
    const replayed = new Set<string>();

    for (const message of messages) {
      if (typeof message.content === 'string') {
        contents.push({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        });
        continue;
      }

      if (message.role === 'assistant') {
        const toolUses = message.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );
        const cached = toolUses
          .map((block) => this.contentByCallId.get(block.id))
          .find((value): value is CachedContent => Boolean(value));
        if (cached && !replayed.has(cached.responseId)) {
          contents.push(cached.content);
          replayed.add(cached.responseId);
          continue;
        }

        const parts: Part[] = [];
        for (const block of message.content) {
          if (block.type === 'text') parts.push({ text: block.text });
          if (block.type === 'tool_use') {
            this.callNames.set(block.id, block.name);
            parts.push({
              functionCall: {
                id: block.id,
                name: block.name,
                args: asObject(block.input),
              },
            });
          }
        }
        if (parts.length) contents.push({ role: 'model', parts });
        continue;
      }

      const parts: Part[] = [];
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ text: block.text });
        if (block.type === 'tool_result') {
          const name = this.callNames.get(block.tool_use_id) ?? 'unknown_tool';
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name,
              response: {
                [block.is_error ? 'error' : 'output']: toolResultText(block.content),
              },
            },
          });
        }
      }
      if (parts.length) contents.push({ role: 'user', parts });
    }

    return contents;
  }

  private toAnthropicMessage(
    response: GenerateContentResponse,
    tier: ModelTier,
  ): Anthropic.Message {
    const candidate = response.candidates?.[0];
    const source = candidate?.content ?? { role: 'model', parts: [] };
    const normalizedParts = (source.parts ?? []).map((part) => {
      if (!part.functionCall) return part;
      const id = part.functionCall.id ?? `gemini_${randomUUID()}`;
      const name = part.functionCall.name ?? 'unknown_tool';
      this.callNames.set(id, name);
      return { ...part, functionCall: { ...part.functionCall, id, name } };
    });
    const contentForReplay: Content = { ...source, role: 'model', parts: normalizedParts };
    const responseId = response.responseId ?? `gemini_response_${randomUUID()}`;
    const content: Anthropic.ContentBlock[] = [];

    for (const part of normalizedParts) {
      if (part.text && !part.thought) {
        content.push({ type: 'text', text: part.text, citations: null });
      }
      if (part.functionCall) {
        const id = part.functionCall.id!;
        content.push({
          type: 'tool_use',
          id,
          name: part.functionCall.name!,
          input: part.functionCall.args ?? {},
          caller: { type: 'direct' },
        });
        this.contentByCallId.set(id, { responseId, content: contentForReplay });
      }
    }

    const hasToolUse = content.some((block) => block.type === 'tool_use');
    const refused = isRefusal(candidate?.finishReason);
    return {
      id: responseId,
      type: 'message',
      role: 'assistant',
      model: response.modelVersion ?? this.models[tier],
      content,
      stop_reason: refused ? 'refusal' : hasToolUse ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: response.usageMetadata?.cachedContentTokenCount ?? null,
        server_tool_use: null,
        service_tier: null,
        inference_geo: null,
      },
      ...(refused ? { stop_details: { type: 'refusal' } } : {}),
    } as Anthropic.Message;
  }
}

function toToolConfig(
  choice: Anthropic.MessageCreateParams['tool_choice'] | undefined,
) {
  if (!choice || choice.type === 'auto') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  }
  if (choice.type === 'none') {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  }
  if (choice.type === 'tool') {
    return {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: [choice.name],
      },
    };
  }
  return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((block) => block.type === 'text' ? block.text : JSON.stringify(block))
    .join('\n');
}

function isRefusal(finishReason: string | undefined): boolean {
  return [
    'SAFETY',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'RECITATION',
  ].includes(finishReason ?? '');
}
