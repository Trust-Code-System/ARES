/**
 * Core type contracts for ARES.
 *
 * These types are the seams between the four moving parts of the agent core:
 *   - the orchestrator (the loop)
 *   - the tool registry + individual tools
 *   - the confirmation gate (safety)
 *   - the audit/trace logger
 *
 * Everything here is deliberately storage-agnostic. Phase 2 swaps the in-memory
 * logger and the stub memory retriever for Postgres/pgvector without touching
 * the orchestrator.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';

/**
 * Whether a tool only observes state or changes external state.
 *
 * `state_mutating` tools are routed through the {@link ConfirmationGate} before
 * they execute, unless a standing rule pre-authorizes them. This is a hard,
 * code-level distinction — never a prompt instruction.
 */
export type ToolKind = 'read_only' | 'state_mutating';

/** Structured result returned by a tool's `execute`. */
export interface ToolResult {
  /** False signals the model that the call failed (maps to tool_result is_error). */
  ok: boolean;
  /** Human/model-readable text fed back into the conversation. */
  content: string;
  /** Optional structured payload, recorded in the audit log (not sent to the model). */
  data?: unknown;
}

/** Context handed to every tool invocation. Grows as later phases add capabilities. */
export interface ToolContext {
  logger: Logger;
  /** The run this tool call belongs to — for correlating audit records. */
  runId: string;
  /** Cooperative cancellation (kill switch, timeouts). */
  signal?: AbortSignal;
}

/**
 * A single, typed, self-describing capability.
 *
 * `inputSchema` is a JSON Schema object (`type: "object"`) used verbatim as the
 * Anthropic tool `input_schema`. The orchestrator validates the model's
 * arguments against the declared `required` fields before dispatch.
 */
export interface Tool<I = Record<string, unknown>> {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: Anthropic.Tool.InputSchema;
  /**
   * Whether to send this tool to the API in strict schema-conformance mode.
   * Defaults to `true` for hand-written built-ins (their schemas are crafted to
   * conform). Imported MCP tools set this `false` because their upstream JSON
   * schemas don't necessarily satisfy strict mode.
   */
  strict?: boolean;
  /**
   * Zod schema for the tool input. When present, the orchestrator validates (and
   * strips/coerces) the model's arguments against it before dispatch, and passes
   * the parsed value to `execute`. Built-ins set this (see {@link defineTool});
   * MCP-imported tools don't, so the orchestrator falls back to presence-checking
   * the JSON Schema's `required` list for those.
   */
  inputZod?: ZodType;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/** Decision returned by the confirmation gate for a state-mutating action. */
export interface GateDecision {
  approved: boolean;
  /** Why it was approved/denied — recorded in the audit log. */
  reason: string;
}

/**
 * Guards every state-mutating tool call. Implementations may auto-approve (dev),
 * deny (read-only safe mode), prompt a human, or consult standing rules (Phase 3).
 */
export interface ConfirmationGate {
  requestApproval(req: {
    tool: Tool;
    input: unknown;
    runId: string;
  }): Promise<GateDecision>;
}

/** Where new facts come from before a reasoning step. Stubbed in Phase 1. */
export interface MemoryRetriever {
  /** Returns context text to inject for this input, or '' if none. */
  retrieve(query: string, runId: string): Promise<string>;
}

/** A completed exchange handed to the memory writer for extraction + embedding. */
export interface MemoryTurn {
  runId: string;
  source: AgentInput['source'];
  /** The user/event input text. */
  userText: string;
  /** ARES's final natural-language reply. */
  assistantText: string;
}

/**
 * Persists what was learned from an interaction: extracts structured facts,
 * embeds the exchange, and stores both. Called after a run finishes. Stubbed
 * (absent) in Phase 1; implemented by the ingestor in Phase 2.
 */
export interface MemoryWriter {
  ingest(turn: MemoryTurn): Promise<void>;
}

/** Severity for structured logs. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Minimal structured logger. Phase 2 routes these into the DB audit log. */
export interface Logger {
  log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** An immutable record of one thing ARES did or decided, for the audit trail. */
export interface AuditEvent {
  runId: string;
  ts: string;
  type:
    | 'run_started'
    | 'run_finished'
    | 'model_response'
    | 'tool_requested'
    | 'tool_gate_decision'
    | 'tool_executed'
    | 'tool_failed'
    | 'refusal'
    | 'error';
  detail: Record<string, unknown>;
}

/** Append-only sink for {@link AuditEvent}s. In-memory in Phase 1, DB later. */
export interface AuditLog {
  record(event: AuditEvent): void;
  /** Read back everything for a run (useful for the UI activity feed later). */
  forRun(runId: string): AuditEvent[];
}

/** What the orchestrator is asked to act on. */
export interface AgentInput {
  /** Free-text user message or a serialized triggered event. */
  text: string;
  /** Where it came from — a chat turn vs. a scheduled/triggered event. */
  source: 'user' | 'event';
  /** Specialist guidance profile. It changes behavior, never permissions. */
  mode?: AssistantMode;
  /**
   * Per-turn model selection from the UI: `auto` (classify and pick the speed tier),
   * `fast`/`smart`, or `<provider>:<tier>` (e.g. `openai:fast`). Parsed by
   * {@link parseModelChoice}; an unknown/absent value behaves as `auto`.
   */
  model?: string;
  /**
   * Per-turn response depth: `quick`, `standard`, or `deep`. Orthogonal to
   * {@link model} — it controls how hard ARES works the turn (tool budget, tier
   * bias, thoroughness). Parsed by `parseEffort`; unknown/absent → `standard`.
   */
  effort?: string;
  /**
   * Prior conversation turns, oldest first, so the model has multi-turn context.
   * Text-only (no tool blocks); the orchestrator normalizes them into a valid
   * alternating user/assistant transcript before the current {@link text}.
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export type AssistantMode =
  | 'general'
  | 'developer'
  | 'research'
  | 'business'
  | 'project'
  | 'document'
  | 'design'
  | 'data'
  | 'office'
  | 'automation'
  | 'hr'
  | 'communications';

/**
 * Live callbacks for a streaming run. All optional — a run with none behaves
 * exactly as before. Lets a UI surface tokens and tool activity as they happen
 * instead of waiting for the whole run to finish (Phase 5 token streaming).
 */
export interface AgentEventHandlers {
  /** A chunk of assistant answer text, delivered as the model produces it. */
  onText?(delta: string): void;
  /** Every {@link AuditEvent}, delivered live the moment it's recorded. */
  onAudit?(event: AuditEvent): void;
}

/** Outcome of a full agent run. */
export interface AgentRunResult {
  runId: string;
  /** The model's final natural-language answer, if any. */
  finalText: string;
  /** Why the loop ended. */
  stopReason: 'completed' | 'refusal' | 'max_iterations' | 'aborted' | 'error';
  /** Number of model round trips taken. */
  iterations: number;
  /** Tool calls executed, in order. */
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** True when answered via the lightweight conversational fast path (no tools/memory). */
  fastChat?: boolean;
}
