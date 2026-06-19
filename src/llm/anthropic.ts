/**
 * Thin wrapper around the Anthropic Messages API.
 *
 * Centralizes the things every call in ARES must get right:
 *   - model selection (reasoning vs. fast tier)
 *   - adaptive thinking (the recommended mode for Opus 4.8 — no budget_tokens)
 *   - effort + max_tokens defaults
 *
 * The orchestrator drives the agentic loop manually (see orchestrator.ts) rather
 * than using the SDK tool runner, because ARES needs to intercept every tool call
 * for the confirmation gate and the audit log.
 */

import Anthropic from '@anthropic-ai/sdk';
import { redactSensitiveData, redactSensitiveText } from '../security/redactor.js';

export type ModelTier = 'reasoning' | 'fast';

export interface AnthropicClientOptions {
  apiKey: string;
  reasoningModel: string;
  fastModel: string;
}

export interface CreateMessageParams {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  tier?: ModelTier;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Force or constrain tool selection (e.g. forced structured extraction). */
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
  /**
   * Override thinking. Defaults to adaptive/summarized. The ingestor disables it
   * (`{ type: 'disabled' }`) because forced tool use does not require reasoning
   * and it keeps extraction fast and cheap.
   */
  thinking?: Anthropic.MessageCreateParams['thinking'];
  /**
   * When set, the call streams and `onText` is invoked with each text delta as
   * the model produces it. The final assembled {@link Anthropic.Message} is still
   * returned, so the orchestrator's loop is identical either way — streaming only
   * adds live token delivery. Thinking deltas are NOT forwarded, only answer text.
   */
  onText?: (delta: string) => void;
}

export class AnthropicClient {
  private readonly sdk: Anthropic;
  private readonly models: Record<ModelTier, string>;

  constructor(opts: AnthropicClientOptions) {
    this.sdk = new Anthropic({ apiKey: opts.apiKey });
    this.models = { reasoning: opts.reasoningModel, fast: opts.fastModel };
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async createMessage(params: CreateMessageParams): Promise<Anthropic.Message> {
    const tier = params.tier ?? 'reasoning';
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.models[tier],
      max_tokens: params.maxTokens ?? 16000,
      // Adaptive thinking: Claude decides when/how much to reason and
      // interleaves it between tool calls. `summarized` so traces are legible.
      thinking: params.thinking ?? { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      system: redactSensitiveText(params.system),
      tools: params.tools,
      messages: redactSensitiveData(params.messages),
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    };
    const options = params.signal ? { signal: params.signal } : undefined;

    // No live consumer → the simpler non-streaming call.
    if (!params.onText) {
      return this.sdk.messages.create(body, options);
    }

    // Stream so text deltas reach the UI as they're generated; `finalMessage()`
    // still resolves to the same complete message the loop expects (tool_use +
    // thinking blocks intact).
    const stream = this.sdk.messages.stream(body, options);
    stream.on('text', (delta) => params.onText!(delta));
    return stream.finalMessage();
  }
}
