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

      // 1. Retrieve relevant memory and fold it into the system prompt.
      const memoryContext = await this.opts.memory.retrieve(input.text, runId);
      const baseSystem = `${this.opts.systemPrompt}\n\n## Active mode\n${modeInstruction(input.mode)}`;
      const system = memoryContext
        ? `${baseSystem}\n\n## Relevant memory\n${memoryContext}`
        : baseSystem;

      const tools = this.opts.registry.toAnthropicTools();
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input.text }];

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
