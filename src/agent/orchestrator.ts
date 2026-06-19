/**
 * The agent loop — the Brain (Phase 1).
 *
 * One run is: perceive → retrieve context → reason (Claude) → act (tools) → log,
 * looping reason↔act until the model is done or a guard trips.
 *
 * Design choices that matter:
 *   - MANUAL agentic loop (not the SDK tool runner) so every tool call can be
 *     routed through the confirmation gate and recorded in the audit log.
 *   - The full `response.content` is appended verbatim each turn, which preserves
 *     thinking blocks and tool_use blocks exactly as required for multi-turn
 *     adaptive thinking.
 *   - A hard `maxIterations` cap is a code-level guard against runaway loops.
 */

import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  AgentEventHandlers,
  AgentInput,
  AgentRunResult,
  AuditEvent,
  AuditLog,
  ConfirmationGate,
  Logger,
  MemoryRetriever,
  MemoryWriter,
  Tool,
  ToolContext,
} from '../types.js';
import type { CreateMessageParams, ModelTier } from '../llm/anthropic.js';
import type { ModelRouter } from '../llm/router.js';
import { parseModelChoice, type ParsedModelChoice } from '../llm/modelChoice.js';
import type { ToolRegistry } from '../tools/registry.js';
import { formatZodError } from '../tools/define.js';
import { containsSensitiveData, redactSensitiveData, redactSensitiveText } from '../security/redactor.js';
import { modeInstruction } from './modes.js';
import { parseEffort, effortProfile } from './effort.js';
import type { PreferenceSeeder } from '../feedback/actionRanking.js';

export interface MessageClient {
  createMessage(params: CreateMessageParams): Promise<Anthropic.Message>;
}

/**
 * Fast-tier router prompt: classify a user turn by how much model it needs, so
 * `Auto` model selection can answer trivial chat instantly, run simple requests on
 * the quick model, and reserve the slow reasoning model for genuinely hard work.
 */
const ROUTER_INSTRUCTION =
  'You are a fast router for the assistant ARES. Classify the user\'s latest message '
  + 'into EXACTLY one word — CHAT, SIMPLE, or COMPLEX:\n'
  + '- CHAT: greetings, small talk, pleasantries, thanks, feelings, opinions, or simple '
  + 'chit-chat that needs no tools, no stored personal facts, and no real-time data.\n'
  + '- SIMPLE: a real but straightforward request — one clear question, a quick lookup, '
  + 'calculation, short factual or how-to answer, or light editing — answerable directly '
  + 'or with at most one tool call.\n'
  + '- COMPLEX: anything needing multi-step reasoning, several tools, coding or '
  + 'architecture, deep analysis, or a long/careful answer.\n'
  + 'When in doubt, answer COMPLEX.';

/** System guidance for the lightweight conversational reply. */
const CONVERSATIONAL_INSTRUCTION =
  'This is a casual, real-time conversation (often spoken aloud). Reply briefly and '
  + 'naturally — warm, friendly, and human, usually a sentence or two. Do not use markdown '
  + 'headings, bullet lists, or code formatting, and do not mention tools. If the user '
  + 'actually needs an action or real information, ask one brief clarifying question.';

export interface AgentOptions {
  client: MessageClient;
  registry: ToolRegistry;
  gate: ConfirmationGate;
  memory: MemoryRetriever;
  logger: Logger;
  audit: AuditLog;
  systemPrompt: string;
  maxIterations: number;
  /**
   * Optional. When set, the exchange is handed to it after the run finishes so
   * facts can be extracted and embedded. Absent in Phase 1 / no-DB mode.
   */
  memoryWriter?: MemoryWriter;
  /**
   * Fast conversational path: route casual user small talk to the fast model with
   * no memory/tools so it answers instantly. Opt-in (default off) — interactive
   * entry points enable it; batch/event runners and tests leave it off.
   */
  enableFastChat?: boolean;
  /**
   * Optional multi-provider router. When present, an explicit `model` choice on the
   * input (e.g. `openai:fast`) is resolved through it so a run can switch provider
   * and tier. Absent → runs always use {@link AgentOptions.client}; an explicit
   * tier still applies, but provider switching is a no-op.
   */
  router?: ModelRouter;
  /**
   * Optional. Called after a run finishes with the run's audit events, so the
   * gate's real decisions can be distilled into preference pairs (see
   * src/feedback/actionRanking.ts). Guarded — it can never fail the turn.
   */
  preferenceSeeder?: PreferenceSeeder;
}

export class Agent {
  constructor(private readonly opts: AgentOptions) {}

  async run(
    input: AgentInput,
    signal?: AbortSignal,
    events?: AgentEventHandlers,
  ): Promise<AgentRunResult> {
    const result = await this.execute(input, signal, events);
    await this.maybeIngest(input, result);
    await this.maybeSeedPreferences(input, result);
    return result;
  }

  /**
   * Distil the run's gate decisions into preference data, if a seeder is wired.
   * Guarded — preference seeding is a learning nicety and must never fail a turn.
   */
  private async maybeSeedPreferences(input: AgentInput, result: AgentRunResult): Promise<void> {
    const seeder = this.opts.preferenceSeeder;
    if (!seeder) return;
    try {
      await seeder({ events: this.opts.audit.forRun(result.runId), input, result });
    } catch (err) {
      this.opts.logger.error('preference seeder threw', {
        runId: result.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Persist what was learned, if a memory writer is configured. Only ingest runs
   * that produced a real answer — never refusals, errors, or aborts. The configured
   * writer is a QueuedMemoryWriter (Phase 4), so this `ingest` only ENQUEUES the
   * exchange and returns fast — the embedding/extraction work happens on a
   * background queue, off the user's hot path. Still guarded so it can't fail the turn.
   */
  private async maybeIngest(input: AgentInput, result: AgentRunResult): Promise<void> {
    const writer = this.opts.memoryWriter;
    if (!writer) return;
    if (result.fastChat) return; // casual small talk carries nothing worth remembering
    if (result.stopReason !== 'completed' && result.stopReason !== 'max_iterations') return;
    if (!result.finalText.trim()) return;
    try {
      await writer.ingest({
        runId: result.runId,
        source: input.source,
        userText: redactSensitiveText(input.text),
        assistantText: redactSensitiveText(result.finalText),
      });
    } catch (err) {
      this.opts.logger.error('memory writer threw', {
        runId: result.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async execute(
    input: AgentInput,
    signal?: AbortSignal,
    events?: AgentEventHandlers,
  ): Promise<AgentRunResult> {
    const runId = randomUUID();
    const { logger } = this.opts;
    const toolCalls: AgentRunResult['toolCalls'] = [];
    const modelInput = sanitizeAgentInput(input);

    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'run_started',
      detail: { source: modelInput.source, text: modelInput.text, mode: modelInput.mode ?? 'general' },
    }, events);
    logger.info('run started', { runId, source: input.source });

    const toolCtx: ToolContext = { logger, runId, ...(signal ? { signal } : {}) };

    let finalText = '';
    let iterations = 0;

    try {
      if (signal?.aborted) {
        return this.finish(runId, finalText, 'aborted', iterations, toolCalls, events);
      }

      // 0. Decide which model handles this run. An explicit `model` choice forces a
      //    provider/tier; `auto` classifies the turn — answering pure chat on the
      //    fast path and picking the task tier (fast vs reasoning) by complexity.
      //    Effort (quick/standard/deep) is an orthogonal depth knob applied on top.
      const profile = effortProfile(parseEffort(input.effort));
      const selection = parseModelChoice(input.model);
      let loopClient: MessageClient = this.opts.client;
      let loopTier: ModelTier = 'reasoning';
      if (selection.mode === 'explicit') {
        const resolved = this.resolveExplicit(selection);
        loopClient = resolved.client;
        loopTier = resolved.tier;
      } else {
        // Deep effort always works the full agent — never the chat fast-path.
        const verdict = profile.forceFullAgent ? 'complex' : await this.routeTurn(modelInput, signal);
        if (verdict === 'chat') return this.fastChatReply(modelInput, runId, signal, events);
        if (verdict === 'simple') loopTier = 'fast';
        // Effort biases the tier on top of the auto classification.
        if (profile.tierBias) loopTier = profile.tierBias;
      }

      // Effort can tighten the tool-round-trip budget for the turn.
      const maxIterations = profile.maxIterationsCap
        ? Math.min(this.opts.maxIterations, profile.maxIterationsCap)
        : this.opts.maxIterations;

      // 1. Retrieve relevant memory and fold it into the system prompt.
      const memoryContext = redactSensitiveText(await this.opts.memory.retrieve(modelInput.text, runId));
      let baseSystem = `${redactSensitiveText(this.opts.systemPrompt)}\n\n## Active mode\n${modeInstruction(input.mode)}`;
      if (profile.instruction) baseSystem += `\n\n## Effort\n${profile.instruction}`;
      const system = memoryContext
        ? `${baseSystem}\n\n## Relevant memory\n${memoryContext}`
        : baseSystem;

      const tools = this.opts.registry.toAnthropicTools();
      const messages: Anthropic.MessageParam[] = buildInitialMessages(modelInput);

      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) {
          return this.finish(runId, finalText, 'aborted', iterations, toolCalls, events);
        }
        iterations++;

        const response = await loopClient.createMessage({
          system,
          messages,
          tools,
          tier: loopTier,
          ...(signal ? { signal } : {}),
          ...(events?.onText ? { onText: (delta: string) => events.onText!(redactSensitiveText(delta)) } : {}),
        });
        const responseContent = sanitizeContentBlocks(response.content);

        this.record({
          runId,
          ts: new Date().toISOString(),
          type: 'model_response',
          detail: {
            stopReason: response.stop_reason,
            usage: response.usage,
            blocks: responseContent.map((b) => b.type),
          },
        }, events);

        // Preserve the assistant turn verbatim (thinking + tool_use blocks).
        messages.push({ role: 'assistant', content: responseContent });

        finalText = extractText(responseContent) || finalText;

        if (response.stop_reason === 'refusal') {
          this.record({
            runId,
            ts: new Date().toISOString(),
            type: 'refusal',
            detail: { stopDetails: response.stop_details ?? null },
          }, events);
          logger.warn('model refused', { runId });
          return this.finish(runId, finalText, 'refusal', iterations, toolCalls, events);
        }

        const toolUses = responseContent.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        // No tool calls → the model is done.
        if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
          logger.info('run completed', { runId, iterations });
          return this.finish(runId, finalText, 'completed', iterations, toolCalls, events);
        }

        // 4. Execute each requested tool, collect results for the next turn.
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const { block, ok } = await this.dispatch(use, toolCtx, events);
          results.push(block);
          toolCalls.push({ name: use.name, ok });
        }
        messages.push({ role: 'user', content: results });
      }

      logger.warn('hit max iterations', { runId, max: maxIterations });
      return this.finish(runId, finalText, 'max_iterations', iterations, toolCalls, events);
    } catch (err) {
      if (isAbortError(err, signal)) {
        logger.warn('run aborted', { runId });
        return this.finish(runId, finalText, 'aborted', iterations, toolCalls, events);
      }
      const message = errorMessage(err);
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: 'error',
        detail: { message },
      }, events);
      logger.error('run errored', { runId, error: message });
      return this.finish(runId, finalText, 'error', iterations, toolCalls, events);
    }
  }

  /**
   * Resolve, gate, and execute a single tool_use block. Always returns a
   * tool_result block so the conversation stays well-formed (the API rejects a
   * follow-up where any tool_use id lacks a matching tool_result).
   */
  private async dispatch(
    use: Anthropic.ToolUseBlock,
    ctx: ToolContext,
    events?: AgentEventHandlers,
  ): Promise<{ block: Anthropic.ToolResultBlockParam; ok: boolean }> {
    const { logger } = this.opts;
    const runId = ctx.runId;
    const tool = this.opts.registry.get(use.name);
    const safeInput = redactSensitiveData(use.input);

    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'tool_requested',
      detail: { tool: use.name, input: safeInput },
    }, events);

    if (!tool || !this.opts.registry.isEnabled(use.name)) {
      const error = tool ? 'disabled tool' : 'unknown tool';
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: 'tool_failed',
        detail: { tool: use.name, error },
      }, events);
      return this.errorResult(
        use.id,
        tool ? `Tool "${use.name}" is disabled.` : `Unknown tool "${use.name}".`,
      );
    }

    if (containsSensitiveData(use.input)) {
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: 'tool_failed',
        detail: { tool: use.name, error: 'sensitive input blocked' },
      }, events);
      return this.errorResult(
        use.id,
        'Sensitive authentication data must be entered manually by the user and cannot be passed to tools, memory, logs, or models.',
      );
    }

    // Validate the model's arguments. Zod-described built-ins parse against their
    // schema (rejecting/stripping malformed input); MCP tools without a Zod schema
    // fall back to presence-checking the JSON Schema's `required` list.
    let toolInput: unknown = use.input;
    if (tool.inputZod) {
      const parsed = tool.inputZod.safeParse(use.input);
      if (!parsed.success) {
        const detail = formatZodError(parsed.error);
        this.record({
          runId,
          ts: new Date().toISOString(),
          type: 'tool_failed',
          detail: { tool: use.name, error: 'invalid arguments', issues: detail },
        }, events);
        return this.errorResult(use.id, `Invalid argument(s): ${detail}.`);
      }
      toolInput = parsed.data;
    } else {
      const missing = missingRequired(tool, use.input);
      if (missing.length) {
        this.record({
          runId,
          ts: new Date().toISOString(),
          type: 'tool_failed',
          detail: { tool: use.name, error: 'missing required arguments', missing },
        }, events);
        return this.errorResult(
          use.id,
          `Missing required argument(s): ${missing.join(', ')}.`,
        );
      }
    }

    // Safety gate: state-mutating tools must be approved before they run.
    if (tool.kind === 'state_mutating') {
      const decision = await this.opts.gate.requestApproval({
        tool,
        input: safeInput,
        runId,
      });
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: 'tool_gate_decision',
        detail: { tool: use.name, approved: decision.approved, reason: decision.reason },
      }, events);
      if (!decision.approved) {
        logger.warn('tool blocked by gate', { tool: use.name, reason: decision.reason });
        return this.errorResult(
          use.id,
          `Action not approved: ${decision.reason}. Do not retry without a different plan.`,
        );
      }
    }

    try {
      const result = await tool.execute(toolInput as Record<string, unknown>, ctx);
      const safeContent = redactSensitiveText(result.content);
      const safeData = redactSensitiveData(result.data ?? null);
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: result.ok ? 'tool_executed' : 'tool_failed',
        detail: { tool: use.name, ok: result.ok, data: safeData },
      }, events);
      logger.info('tool executed', { tool: use.name, ok: result.ok });
      return {
        ok: result.ok,
        block: {
          type: 'tool_result',
          tool_use_id: use.id,
          content: safeContent,
          is_error: !result.ok,
        },
      };
    } catch (err) {
      if (isAbortError(err, ctx.signal)) throw err;
      const message = errorMessage(err);
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: 'tool_failed',
        detail: { tool: use.name, error: message },
      }, events);
      return this.errorResult(use.id, `Tool threw: ${message}`);
    }
  }

  private errorResult(
    toolUseId: string,
    message: string,
  ): { block: Anthropic.ToolResultBlockParam; ok: boolean } {
    return {
      ok: false,
      block: { type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true },
    };
  }

  /**
   * Resolve an explicit `model` choice to a concrete client + tier. With a router
   * configured, a named provider switches both; without one (or with no provider
   * named) the default client is kept and only the tier applies.
   */
  private resolveExplicit(sel: ParsedModelChoice): { client: MessageClient; tier: ModelTier } {
    const tier: ModelTier = sel.tier ?? 'reasoning';
    if (sel.provider && this.opts.router) {
      const resolved = this.opts.router.resolve({ override: { provider: sel.provider, tier } });
      return { client: resolved.client, tier: resolved.tier };
    }
    return { client: this.opts.client, tier };
  }

  /**
   * Classify a turn for `Auto` model selection: 'chat' (answer on the fast path),
   * 'simple' (full agent on the fast tier), or 'complex' (full agent on reasoning).
   * Fail-safe: the same source/mode guards as the fast path gate it, and anything
   * not eligible — or a classifier error — yields 'complex' (the prior behaviour).
   */
  private async routeTurn(
    input: AgentInput,
    signal?: AbortSignal,
  ): Promise<'chat' | 'simple' | 'complex'> {
    if (!this.opts.enableFastChat) return 'complex';
    if (input.source !== 'user') return 'complex';
    if (input.mode && input.mode !== 'general') return 'complex';

    // Unambiguous small talk ("hi", "thanks", "good morning") skips the classifier
    // round-trip entirely and answers immediately — the single biggest latency cut
    // for trivial spoken turns. Whole-message match only, so it can never misroute a
    // real request; anything else still pays for the COMPLEX-biased classifier.
    if (isObviousSmallTalk(input.text)) return 'chat';
    try {
      return await this.classifyTurn(input, signal);
    } catch {
      return 'complex'; // classifier failed → use the full agent on reasoning
    }
  }

  /**
   * Lightweight conversational reply for a turn already classified as 'chat': a
   * brief answer on the fast model with no memory retrieval and no tools.
   */
  private async fastChatReply(
    input: AgentInput,
    runId: string,
    signal: AbortSignal | undefined,
    events?: AgentEventHandlers,
  ): Promise<AgentRunResult> {
    const system = `${redactSensitiveText(this.opts.systemPrompt)}\n\n## Conversational mode\n${CONVERSATIONAL_INSTRUCTION}`;
    const response = await this.opts.client.createMessage({
      system,
      messages: buildInitialMessages(input),
      tools: [],
      tier: 'fast',
      maxTokens: 600,
      ...(signal ? { signal } : {}),
      ...(events?.onText ? { onText: (delta: string) => events.onText!(redactSensitiveText(delta)) } : {}),
    });

    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'model_response',
      detail: { fastChat: true, tier: 'fast', stopReason: response.stop_reason, usage: response.usage },
    }, events);
    this.opts.logger.info('fast chat reply', { runId });

    return { ...this.finish(runId, extractText(sanitizeContentBlocks(response.content)), 'completed', 1, [], events), fastChat: true };
  }

  /** One fast-tier classification call. Ambiguous/empty/legacy → 'complex' (fail-safe). */
  private async classifyTurn(
    input: AgentInput,
    signal?: AbortSignal,
  ): Promise<'chat' | 'simple' | 'complex'> {
    const response = await this.opts.client.createMessage({
      system: ROUTER_INSTRUCTION,
      messages: [{ role: 'user', content: redactSensitiveText(input.text) }],
      tools: [],
      tier: 'fast',
      maxTokens: 16,
      ...(signal ? { signal } : {}),
    });
    const verdict = extractText(response.content).toLowerCase();
    if (verdict.includes('chat')) return 'chat';
    if (verdict.includes('simple')) return 'simple';
    return 'complex';
  }

  private finish(
    runId: string,
    finalText: string,
    stopReason: AgentRunResult['stopReason'],
    iterations: number,
    toolCalls: AgentRunResult['toolCalls'],
    events?: AgentEventHandlers,
  ): AgentRunResult {
    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'run_finished',
      detail: { stopReason, iterations, toolCalls },
    }, events);
    return { runId, finalText: redactSensitiveText(finalText), stopReason, iterations, toolCalls };
  }

  private record(event: AuditEvent, events?: AgentEventHandlers): void {
    this.opts.audit.record(event);
    if (!events?.onAudit) return;
    try {
      events.onAudit(structuredClone(event));
    } catch (err) {
      this.opts.logger.warn('agent event handler threw', {
        runId: event.runId,
        type: event.type,
        error: errorMessage(err),
      });
    }
  }
}

/**
 * Curated phrases that are *always* casual chat — no tools, memory, or real-time
 * data could be needed. Matched against the whole, punctuation-stripped message so
 * "what's the weather" never qualifies; only a bare greeting/thanks/farewell does.
 */
const SMALL_TALK = new Set([
  'hi', 'hii', 'hello', 'helo', 'hey', 'heya', 'hiya', 'yo', 'sup', 'hey there',
  'hi there', 'hello there', 'hi ares', 'hey ares', 'hello ares', 'hiya ares',
  'good morning', 'good afternoon', 'good evening', 'morning', 'evening',
  'thanks', 'thank you', 'thank you so much', 'thanks so much', 'thanks a lot',
  'thanks ares', 'thank you ares', 'thx', 'ty', 'tysm', 'cheers', 'appreciate it',
  'much appreciated', 'bye', 'goodbye', 'see you', 'see ya', 'later', 'good night',
  'goodnight', 'gn', 'ok', 'okay', 'k', 'kk', 'cool', 'nice', 'great', 'awesome',
  'perfect', 'got it', 'sounds good', 'no worries', 'np', 'haha', 'lol', 'lmao',
  'ok thanks', 'okay thanks', 'cool thanks', 'great thanks', 'how are you',
  "how's it going", 'hows it going', "what's up", 'whats up', 'how do you do',
  'how are you doing', 'nice to meet you',
]);

/** True when the entire message is unambiguous small talk (greeting/thanks/etc.). */
function isObviousSmallTalk(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 40) return false;
  return SMALL_TALK.has(normalized);
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Build the opening message list from any prior history plus the current user
 * text. The Anthropic API requires messages to start with `user` and strictly
 * alternate roles, so consecutive same-role turns are merged and any leading
 * assistant turns are dropped.
 */
function buildInitialMessages(input: AgentInput): Anthropic.MessageParam[] {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const push = (role: 'user' | 'assistant', raw: string) => {
    const content = raw.trim();
    if (!content) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  };
  for (const turn of input.history ?? []) push(turn.role, redactSensitiveText(turn.content));
  push('user', redactSensitiveText(input.text));
  while (turns.length > 0 && turns[0]!.role !== 'user') turns.shift();
  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
}

function sanitizeAgentInput(input: AgentInput): AgentInput {
  return {
    ...input,
    text: redactSensitiveText(input.text),
    ...(input.history
      ? {
          history: input.history.map((turn) => ({
            role: turn.role,
            content: redactSensitiveText(turn.content),
          })),
        }
      : {}),
  };
}

function sanitizeContentBlocks(content: Anthropic.ContentBlock[]): Anthropic.ContentBlock[] {
  return redactSensitiveData(structuredClone(content));
}

/** Validate the model's args against the tool's declared `required` list. */
function missingRequired(tool: Tool, input: unknown): string[] {
  const required = tool.inputSchema.required ?? [];
  if (typeof input !== 'object' || input === null) return [...required];
  const obj = input as Record<string, unknown>;
  return required.filter((key) => obj[key] === undefined);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError'))
  );
}
