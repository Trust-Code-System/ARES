/**
 * Per-task model router (Phase 8).
 *
 * The existing {@link buildLlmClient} picks ONE provider for the whole process
 * from `ARES_LLM_PROVIDER`. This adds a finer layer on top: given the *shape* of
 * a task, choose the best provider + tier among the providers that actually have
 * keys configured, with a deterministic policy, a manual override, and automatic
 * fallback when a provider errors. It wraps the factory — it does not replace it,
 * so existing single-provider wiring keeps working untouched.
 *
 * Policy (from the project's Phase-8 guidance):
 * - Anthropic (Claude) for deep coding, architecture, and long-context reasoning.
 * - OpenAI for structured output, tool-heavy, and latency-sensitive assistant work.
 * - Gemini as a capable generalist / multimodal fallback.
 * The decision function {@link selectRoute} is pure and unit-tested in isolation;
 * the {@link ModelRouter} binds it to real clients.
 */

import type { Config } from '../config.js';
import type { Logger } from '../types.js';
import type { MessageClient } from '../agent/orchestrator.js';
import { AnthropicClient } from './anthropic.js';
import { GeminiClient } from './gemini.js';
import { OpenAIResponsesClient } from './openai.js';
import type { LlmRuntime } from './factory.js';
import { providerDisplayName, type ModelOption } from './modelChoice.js';

export type Provider = 'anthropic' | 'openai' | 'gemini';
export type ModelTier = 'reasoning' | 'fast';

export type TaskKind =
  | 'code'
  | 'architecture'
  | 'writing'
  | 'structured'
  | 'research'
  | 'conversation'
  | 'extraction'
  | 'vision'
  | 'general';

/** What we know about a task when routing it. Every field optional. */
export interface RoutingTask {
  kind?: TaskKind;
  /** Large codebase / long document — favours long-context models (Claude). */
  needsLongContext?: boolean;
  /** Strict JSON / tool replay — favours OpenAI. */
  needsStructuredOutput?: boolean;
  /** Voice / live chat — favours the fast tier and a low-latency provider. */
  latencySensitive?: boolean;
  /** Caller-forced choice; always wins over the policy. */
  override?: { provider?: Provider; tier?: ModelTier };
}

export interface Route {
  provider: Provider;
  tier: ModelTier;
  /** Why this route was chosen (logged, surfaced in evals). */
  reason: string;
}

/** Kinds that prefer Claude's depth / long context. */
const CLAUDE_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(['code', 'architecture']);
/** Kinds that prefer OpenAI's structured/tool/latency profile. */
const OPENAI_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(['structured', 'conversation', 'extraction']);
/** Kinds that run on the cheaper fast tier. */
const FAST_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(['conversation', 'extraction']);

/**
 * Pure routing decision. `available` is the set of providers with keys;
 * `fallbackOrder` decides ties and is also the order tried on failure (the
 * configured default provider should lead it).
 */
export function selectRoute(
  task: RoutingTask,
  available: ReadonlySet<Provider>,
  fallbackOrder: readonly Provider[],
): Route {
  if (available.size === 0) throw new Error('no LLM providers are configured');

  const pick = (preferred: Provider | undefined, reason: string): Route => {
    const tier = decideTier(task);
    if (preferred && available.has(preferred)) return { provider: preferred, tier, reason };
    // Fall back to the first available provider in the configured order.
    // `available` is non-empty (checked above), so the final fallback is defined.
    const fb = fallbackOrder.find((p) => available.has(p)) ?? [...available][0]!;
    const why = preferred ? `${reason}; ${preferred} unavailable, fell back to ${fb}` : reason;
    return { provider: fb, tier, reason: why };
  };

  // 1. Manual override always wins.
  if (task.override?.provider && available.has(task.override.provider)) {
    return {
      provider: task.override.provider,
      tier: task.override.tier ?? decideTier(task),
      reason: 'manual override',
    };
  }

  // 2. Long context or code/architecture → Claude.
  if (task.needsLongContext) return pick('anthropic', 'long-context task → Claude');
  if (task.kind && CLAUDE_KINDS.has(task.kind)) return pick('anthropic', `${task.kind} → Claude`);

  // 3. Structured output / tool-heavy / latency-sensitive → OpenAI.
  if (task.needsStructuredOutput) return pick('openai', 'structured output → OpenAI');
  if (task.latencySensitive) return pick('openai', 'latency-sensitive → OpenAI fast');
  if (task.kind && OPENAI_KINDS.has(task.kind)) return pick('openai', `${task.kind} → OpenAI`);

  // 4. Everything else → the configured default (head of fallback order).
  return pick(fallbackOrder[0], 'general task → default provider');
}

function decideTier(task: RoutingTask): ModelTier {
  if (task.override?.tier) return task.override.tier;
  if (task.latencySensitive) return 'fast';
  if (task.kind && FAST_KINDS.has(task.kind)) return 'fast';
  return 'reasoning';
}

export interface ResolvedModel {
  client: MessageClient;
  provider: Provider;
  tier: ModelTier;
  model: string;
  reason: string;
}

/**
 * Binds {@link selectRoute} to real provider clients. Build it from config; it
 * only holds clients for providers that have a key, so routing never points at
 * an unconfigured provider.
 */
export class ModelRouter {
  private readonly runtimes: Map<Provider, LlmRuntime>;
  private readonly available: Set<Provider>;
  private readonly order: Provider[];

  constructor(runtimes: Map<Provider, LlmRuntime>, defaultProvider: Provider, private readonly logger?: Logger) {
    if (runtimes.size === 0) throw new Error('ModelRouter needs at least one provider runtime');
    this.runtimes = runtimes;
    this.available = new Set(runtimes.keys());
    // Default provider leads the fallback order; the rest follow in a stable order.
    const rest = (['anthropic', 'openai', 'gemini'] as Provider[]).filter(
      (p) => p !== defaultProvider && this.available.has(p),
    );
    this.order = [defaultProvider, ...rest].filter((p) => this.available.has(p));
    if (this.order.length === 0) this.order = [...this.available];
  }

  /** Providers this router can actually use. */
  get providers(): Provider[] {
    return [...this.available];
  }

  /** The configured fast/reasoning model id for each available provider, in fallback order. */
  catalog(): Array<{ provider: Provider; fastModel: string; reasoningModel: string }> {
    return this.order.map((provider) => {
      const rt = this.runtimes.get(provider)!;
      return { provider, fastModel: rt.fastModel, reasoningModel: rt.reasoningModel };
    });
  }

  /**
   * The selectable model options for the UI: `Auto` first, then a fast and a
   * reasoning entry per available provider (in fallback order, so the default
   * provider leads). The wire `id`s round-trip through {@link parseModelChoice}.
   */
  modelOptions(): ModelOption[] {
    const options: ModelOption[] = [{ id: 'auto', label: 'Auto', detail: 'picks speed by question' }];
    for (const { provider, fastModel, reasoningModel } of this.catalog()) {
      const name = providerDisplayName(provider);
      options.push({ id: `${provider}:fast`, label: `${name} · Fast`, detail: fastModel });
      options.push({ id: `${provider}:reasoning`, label: `${name} · Smart`, detail: reasoningModel });
    }
    return options;
  }

  /** Resolve a task to a concrete client + model. */
  resolve(task: RoutingTask): ResolvedModel {
    const route = selectRoute(task, this.available, this.order);
    const runtime = this.runtimes.get(route.provider)!;
    const model = route.tier === 'fast' ? runtime.fastModel : runtime.reasoningModel;
    this.logger?.debug('model route', { ...route, model });
    return { client: runtime.client, provider: route.provider, tier: route.tier, model, reason: route.reason };
  }

  /**
   * The ordered provider chain for a task: the routed primary first, then the
   * remaining available providers (same tier) in fallback order. Callers that own
   * their own retry/stream semantics (e.g. the agent loop) consume this directly;
   * {@link withFallback} wraps it with a try-next loop.
   */
  resolveChain(task: RoutingTask): ResolvedModel[] {
    const primary = this.resolve(task);
    const tried = new Set<Provider>([primary.provider]);
    const chain: ResolvedModel[] = [primary];
    for (const p of this.order) {
      if (tried.has(p)) continue;
      tried.add(p);
      const rt = this.runtimes.get(p)!;
      chain.push({
        client: rt.client,
        provider: p,
        tier: primary.tier,
        model: primary.tier === 'fast' ? rt.fastModel : rt.reasoningModel,
        reason: `fallback after ${primary.provider} failed`,
      });
    }
    return chain;
  }

  /**
   * Run `fn` against the resolved client, falling back to the remaining providers
   * (same tier) on error. Returns the result of the first provider that succeeds.
   */
  async withFallback<T>(task: RoutingTask, fn: (m: ResolvedModel) => Promise<T>): Promise<T> {
    const chain = this.resolveChain(task);
    let lastErr: unknown;
    for (const m of chain) {
      try {
        return await fn(m);
      } catch (err) {
        lastErr = err;
        this.logger?.warn('provider failed, trying fallback', {
          provider: m.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all providers failed');
  }
}

/** Build an {@link LlmRuntime} for each provider that has a key configured. */
export function buildAllLlmRuntimes(config: Config): Map<Provider, LlmRuntime> {
  const runtimes = new Map<Provider, LlmRuntime>();

  if (config.anthropicApiKey) {
    runtimes.set('anthropic', {
      client: new AnthropicClient({
        apiKey: config.anthropicApiKey,
        reasoningModel: config.reasoningModel,
        fastModel: config.fastModel,
      }),
      provider: 'anthropic',
      reasoningModel: config.reasoningModel,
      fastModel: config.fastModel,
    });
  }

  if (config.openaiApiKey) {
    runtimes.set('openai', {
      client: new OpenAIResponsesClient({
        apiKey: config.openaiApiKey,
        reasoningModel: config.openaiReasoningModel,
        fastModel: config.openaiFastModel,
        ...(config.openaiBaseUrl ? { baseUrl: config.openaiBaseUrl } : {}),
      }),
      provider: 'openai',
      reasoningModel: config.openaiReasoningModel,
      fastModel: config.openaiFastModel,
    });
  }

  if (config.geminiApiKey) {
    runtimes.set('gemini', {
      client: new GeminiClient({
        apiKey: config.geminiApiKey,
        reasoningModel: config.geminiReasoningModel,
        fastModel: config.geminiFastModel,
      }),
      provider: 'gemini',
      reasoningModel: config.geminiReasoningModel,
      fastModel: config.geminiFastModel,
    });
  }

  return runtimes;
}

/**
 * Build a {@link ModelRouter} from config, or `undefined` when no provider has a
 * key (callers then keep using the single {@link buildLlmClient}). The configured
 * `llmProvider` leads the fallback order.
 */
export function buildModelRouter(config: Config, logger?: Logger): ModelRouter | undefined {
  const runtimes = buildAllLlmRuntimes(config);
  if (runtimes.size === 0) return undefined;
  const preferred: Provider = runtimes.has(config.llmProvider)
    ? config.llmProvider
    : [...runtimes.keys()][0]!;
  return new ModelRouter(runtimes, preferred, logger);
}
