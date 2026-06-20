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

/**
 * SDK-level retry budget for transient provider errors (HTTP 429 rate-limit
 * bursts, 5xx, request timeouts). The Anthropic and OpenAI SDKs retry these with
 * exponential backoff and honour `Retry-After`. The default is 2 — raised so a
 * brief rate-limit burst is absorbed silently. The orchestrator's cross-provider
 * fallback only engages once a provider has exhausted these retries.
 */
export const LLM_MAX_RETRIES = 5;

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
    this.sdk = new Anthropic({ apiKey: opts.apiKey, maxRetries: LLM_MAX_RETRIES });
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
      tools: params.tools.map(sanitizeAnthropicTool),
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

/**
 * Validation/range keywords Anthropic's tool-schema validator rejects (it accepts
 * only a strict JSON-Schema subset, much like OpenAI strict mode). Each is stripped
 * and folded into the property description with this human label so the model still
 * sees the constraint. The tool's own Zod schema re-validates input at execution.
 */
const CONSTRAINT_LABEL: Record<string, string> = {
  minimum: '>=',
  maximum: '<=',
  exclusiveMinimum: '>',
  exclusiveMaximum: '<',
  minLength: 'minLength',
  maxLength: 'maxLength',
  minItems: 'minItems',
  maxItems: 'maxItems',
};
/** Keywords Anthropic rejects outright that carry no useful hint to fold in. */
const DROPPED_KEYS = new Set(['propertyNames']);

/**
 * Sanitize a JSON-Schema node for Anthropic's tool validator. Concretely:
 *   - strip range/length keywords, folding them into the property description
 *     (`For 'integer' type, properties maximum, minimum are not supported`);
 *   - coerce any non-false `additionalProperties` to `false`
 *     (`For 'object' type, 'additionalProperties: object' is not supported`);
 *   - drop `propertyNames` (`property 'propertyNames' is not supported`).
 * Nothing is lost operationally — the tool's Zod schema still enforces the real
 * constraints at execution time; this only relaxes the API-facing description.
 */
function sanitizeAnthropicSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeAnthropicSchema);
  if (!node || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const constraints: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key in CONSTRAINT_LABEL && (typeof value === 'number' || typeof value === 'string')) {
      constraints.push(`${CONSTRAINT_LABEL[key]!} ${value}`);
      continue;
    }
    if (DROPPED_KEYS.has(key)) continue;
    // Anthropic requires `additionalProperties` to be `false` when present; a nested
    // schema (open map) is rejected. Forbid extra keys at the API boundary.
    if (key === 'additionalProperties' && value !== false) {
      out.additionalProperties = false;
      continue;
    }
    out[key] = sanitizeAnthropicSchema(value);
  }
  if (constraints.length > 0) {
    const note = `Constraints: ${constraints.join(', ')}.`;
    out.description = typeof out.description === 'string' && out.description ? `${out.description} ${note}` : note;
  }
  return out;
}

/**
 * Prepare one tool for the Anthropic Messages API. Anthropic caps *strict* tools at
 * 20 and enforces a restricted JSON-Schema subset on them; ARES ships ~50 tools, so
 * they are sent non-strict. (The OpenAI adapter reads `strict` off the original tool
 * objects and is unaffected — this clones.) The schema is still sanitized as
 * defence-in-depth, and each tool's Zod schema re-validates input at execution time.
 */
function sanitizeAnthropicTool(tool: Anthropic.Tool): Anthropic.Tool {
  return {
    ...tool,
    strict: false,
    input_schema: sanitizeAnthropicSchema(tool.input_schema) as Anthropic.Tool['input_schema'],
  };
}

export const __test = { sanitizeAnthropicSchema, sanitizeAnthropicTool };
