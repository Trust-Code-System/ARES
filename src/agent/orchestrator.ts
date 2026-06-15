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
import type { CreateMessageParams } from '../llm/anthropic.js';
import type { ToolRegistry } from '../tools/registry.js';
import { formatZodError } from '../tools/define.js';
import { modeInstruction } from './modes.js';

export interface MessageClient {
  createMessage(params: CreateMessageParams): Promise<Anthropic.Message>;
}

/** Fast-tier router prompt: classify a user turn as casual chat vs. a real task. */
const ROUTER_INSTRUCTION =
  'You are a fast router for the assistant ARES. Decide whether the user\'s latest message '
  + 'can be answered as casual conversation, or needs the full agent.\n\n'
  + 'Answer with EXACTLY one word — CHAT or TASK:\n'
  + '- CHAT: greetings, small talk, pleasantries, thanks, feelings, opinions, or simple '
  + 'chit-chat that needs no tools, no stored personal facts, and no real-time data.\n'
  + '- TASK: anything needing tools or actions (web search, email, calendar, files, shell, '
  + 'code, trading, GitHub), recalling saved facts about the user, real-time or current '
  + 'information (news, weather, prices, the date/time), or multi-step reasoning.\n'
  + 'When in doubt, answer TASK.';

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
    return result;
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
        userText: input.text,
        assistantText: result.finalText,
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

    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'run_started',
      detail: { source: input.source, text: input.text, mode: input.mode ?? 'general' },
    }, events);
    logger.info('run started', { runId, source: input.source });

    const toolCtx: ToolContext = { logger, runId, ...(signal ? { signal } : {}) };

    let finalText = '';
    let iterations = 0;

    try {
      if (signal?.aborted) {
        return this.finish(runId, finalText, 'aborted', iterations, toolCalls, events);
      }

      // 0. Fast path: answer casual small talk on the fast model, skipping memory
      //    retrieval, tools, and the reasoning model. Returns null for real tasks.
      const fast = await this.tryFastChat(input, runId, signal, events);
      if (fast) return fast;

      // 1. Retrieve relevant memory and fold it into the system prompt.
      const memoryContext = await this.opts.memory.retrieve(input.text, runId);
      const baseSystem = `${this.opts.systemPrompt}\n\n## Active mode\n${modeInstruction(input.mode)}`;
      const system = memoryContext
        ? `${baseSystem}\n\n## Relevant memory\n${memoryContext}`
        : baseSystem;

      const tools = this.opts.registry.toAnthropicTools();
      const messages: Anthropic.MessageParam[] = buildInitialMessages(input);

      for (let i = 0; i < this.opts.maxIterations; i++) {
        if (signal?.aborted) {
          return this.finish(runId, finalText, 'aborted', iterations, toolCalls, events);
        }
        iterations++;

        const response = await this.opts.client.createMessage({
          system,
          messages,
          tools,
          tier: 'reasoning',
          ...(signal ? { signal } : {}),
          ...(events?.onText ? { onText: events.onText } : {}),
        });

        this.record({
          runId,
          ts: new Date().toISOString(),
          type: 'model_response',
          detail: {
            stopReason: response.stop_reason,
            usage: response.usage,
            blocks: response.content.map((b) => b.type),
          },
        }, events);

        // Preserve the assistant turn verbatim (thinking + tool_use blocks).
        messages.push({ role: 'assistant', content: response.content });

        finalText = extractText(response.content) || finalText;

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

        const toolUses = response.content.filter(
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

      logger.warn('hit max iterations', { runId, max: this.opts.maxIterations });
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

    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'tool_requested',
      detail: { tool: use.name, input: use.input },
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
        input: use.input,
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
      this.record({
        runId,
        ts: new Date().toISOString(),
        type: result.ok ? 'tool_executed' : 'tool_failed',
        detail: { tool: use.name, ok: result.ok, data: result.data ?? null },
      }, events);
      logger.info('tool executed', { tool: use.name, ok: result.ok });
      return {
        ok: result.ok,
        block: {
          type: 'tool_result',
          tool_use_id: use.id,
          content: result.content,
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
   * Lightweight conversational path. For casual user chat in general mode, a quick
   * fast-tier classifier decides if the turn is small talk; if so we stream a brief
   * reply on the fast model with no memory retrieval and no tools. Anything needing
   * tools, memory, real-time data, or a specific mode returns null and falls through
   * to the full agent. Fail-safe: source/mode guards and a TASK-biased classifier.
   */
  private async tryFastChat(
    input: AgentInput,
    runId: string,
    signal: AbortSignal | undefined,
    events?: AgentEventHandlers,
  ): Promise<AgentRunResult | null> {
    if (!this.opts.enableFastChat) return null;
    if (input.source !== 'user') return null;
    if (input.mode && input.mode !== 'general') return null;

    let kind: 'chat' | 'task';
    try {
      kind = await this.classifyTurn(input, signal);
    } catch {
      return null; // classifier failed → use the full agent
    }
    if (kind !== 'chat') return null;

    const system = `${this.opts.systemPrompt}\n\n## Conversational mode\n${CONVERSATIONAL_INSTRUCTION}`;
    const response = await this.opts.client.createMessage({
      system,
      messages: buildInitialMessages(input),
      tools: [],
      tier: 'fast',
      maxTokens: 600,
      ...(signal ? { signal } : {}),
      ...(events?.onText ? { onText: events.onText } : {}),
    });

    this.record({
      runId,
      ts: new Date().toISOString(),
      type: 'model_response',
      detail: { fastChat: true, tier: 'fast', stopReason: response.stop_reason, usage: response.usage },
    }, events);
    this.opts.logger.info('fast chat reply', { runId });

    return { ...this.finish(runId, extractText(response.content), 'completed', 1, [], events), fastChat: true };
  }

  /** One fast-tier call returning 'chat' or 'task'. Ambiguous/empty → 'task' (fail-safe). */
  private async classifyTurn(input: AgentInput, signal?: AbortSignal): Promise<'chat' | 'task'> {
    const response = await this.opts.client.createMessage({
      system: ROUTER_INSTRUCTION,
      messages: [{ role: 'user', content: input.text }],
      tools: [],
      tier: 'fast',
      maxTokens: 16,
      ...(signal ? { signal } : {}),
    });
    const verdict = extractText(response.content).toLowerCase();
    if (verdict.includes('task')) return 'task';
    if (verdict.includes('chat')) return 'chat';
    return 'task';
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
    return { runId, finalText, stopReason, iterations, toolCalls };
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
  for (const turn of input.history ?? []) push(turn.role, turn.content);
  push('user', input.text);
  while (turns.length > 0 && turns[0]!.role !== 'user') turns.shift();
  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
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
