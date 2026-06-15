import type { Config } from '../config.js';
import type { MessageClient } from '../agent/orchestrator.js';
import { AnthropicClient } from './anthropic.js';
import { GeminiClient } from './gemini.js';
import { OpenAIResponsesClient } from './openai.js';

export interface LlmRuntime {
  client: MessageClient;
  provider: Config['llmProvider'];
  reasoningModel: string;
  fastModel: string;
}

export function buildLlmClient(config: Config): LlmRuntime {
  if (config.llmProvider === 'gemini') {
    const client = new GeminiClient({
      apiKey: config.geminiApiKey!,
      reasoningModel: config.geminiReasoningModel,
      fastModel: config.geminiFastModel,
    });
    return {
      client,
      provider: 'gemini',
      reasoningModel: config.geminiReasoningModel,
      fastModel: config.geminiFastModel,
    };
  }

  if (config.llmProvider === 'openai') {
    const client = new OpenAIResponsesClient({
      apiKey: config.openaiApiKey!,
      reasoningModel: config.openaiReasoningModel,
      fastModel: config.openaiFastModel,
      ...(config.openaiBaseUrl ? { baseUrl: config.openaiBaseUrl } : {}),
    });
    return {
      client,
      provider: 'openai',
      reasoningModel: config.openaiReasoningModel,
      fastModel: config.openaiFastModel,
    };
  }

  const client = new AnthropicClient({
    apiKey: config.anthropicApiKey!,
    reasoningModel: config.reasoningModel,
    fastModel: config.fastModel,
  });
  return {
    client,
    provider: 'anthropic',
    reasoningModel: config.reasoningModel,
    fastModel: config.fastModel,
  };
}
