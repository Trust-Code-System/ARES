/**
 * Safety stores: standing rules + the confirmation queue.
 *
 * Contracts plus in-memory implementations (the no-DB fallback and the test
 * doubles). Postgres implementations live in pgStore.ts. The rule-matching
 * logic ({@link evaluateRules}, {@link matchesRule}) is pure and lives here so
 * it's identical regardless of backend and trivially testable.
 */

import { randomUUID } from 'node:crypto';

export type RuleEffect = 'allow' | 'deny';

/** A pre-authorization (or pre-denial) for tool calls. */
export interface StandingRule {
  id: string;
  /** Tool name this applies to, or '*' for any tool. */
  tool: string;
  /** Subset predicate over the tool input; {} matches any input. */
  match: Record<string, unknown>;
  effect: RuleEffect;
  reason: string;
  enabled: boolean;
  createdAt: string;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
}

export interface NewStandingRule {
  tool: string;
  match?: Record<string, unknown>;
  effect: RuleEffect;
  reason?: string;
  expiresAt?: string | null;
}

export interface StandingRulesStore {
  /** Enabled, non-expired rules that apply to `tool` (including '*' rules). */
  findForTool(tool: string): Promise<StandingRule[]>;
  add(rule: NewStandingRule): Promise<StandingRule>;
  list(): Promise<StandingRule[]>;
}

export type ConfirmationStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ConfirmationRequest {
  id: string;
  runId: string;
  tool: string;
  input: unknown;
  status: ConfirmationStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ConfirmationQueueStore {
  enqueue(req: { runId: string; tool: string; input: unknown; reason?: string }): Promise<ConfirmationRequest>;
  pending(): Promise<ConfirmationRequest[]>;
  resolve(id: string, status: 'approved' | 'denied', resolvedBy: string): Promise<ConfirmationRequest | null>;
}

// ---------------------------------------------------------------------------
// Pure rule logic
// ---------------------------------------------------------------------------

/**
 * Resolve a set of (already tool-filtered) rules against a tool input.
 * Deny beats allow. Returns null if no rule matches.
 */
export function evaluateRules(
  rules: StandingRule[],
  input: unknown,
): { effect: RuleEffect; reason: string } | null {
  const matches = rules.filter((r) => matchesRule(r, input));
  if (matches.length === 0) return null;
  const deny = matches.find((r) => r.effect === 'deny');
  if (deny) return { effect: 'deny', reason: deny.reason || `standing rule ${deny.id}` };
  const allow = matches[0]!;
  return { effect: 'allow', reason: allow.reason || `standing rule ${allow.id}` };
}

/** A rule matches when its `match` object is a deep subset of the tool input. */
export function matchesRule(rule: StandingRule, input: unknown): boolean {
  return isSubset(rule.match, input);
}

/** True if every key/value in `subset` is present and deep-equal in `value`. */
export function isSubset(subset: unknown, value: unknown): boolean {
  if (subset === null || typeof subset !== 'object') return deepEqual(subset, value);
  if (Array.isArray(subset)) {
    return (
      Array.isArray(value) &&
      subset.length === value.length &&
      subset.every((s, i) => isSubset(s, value[i]))
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.entries(subset as Record<string, unknown>).every(([k, s]) => isSubset(s, v[k]));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

export class InMemoryRulesStore implements StandingRulesStore {
  private readonly rules: StandingRule[] = [];

  async findForTool(tool: string): Promise<StandingRule[]> {
    const now = Date.now();
    return this.rules.filter(
      (r) =>
        r.enabled &&
        (r.tool === tool || r.tool === '*') &&
        (r.expiresAt === null || Date.parse(r.expiresAt) > now),
    );
  }

  async add(rule: NewStandingRule): Promise<StandingRule> {
    const stored: StandingRule = {
      id: randomUUID(),
      tool: rule.tool,
      match: rule.match ?? {},
      effect: rule.effect,
      reason: rule.reason ?? '',
      enabled: true,
      createdAt: new Date().toISOString(),
      expiresAt: rule.expiresAt ?? null,
    };
    this.rules.push(stored);
    return stored;
  }

  async list(): Promise<StandingRule[]> {
    return [...this.rules];
  }
}

export class InMemoryConfirmationQueue implements ConfirmationQueueStore {
  private readonly items: ConfirmationRequest[] = [];

  async enqueue(req: {
    runId: string;
    tool: string;
    input: unknown;
    reason?: string;
  }): Promise<ConfirmationRequest> {
    const item: ConfirmationRequest = {
      id: randomUUID(),
      runId: req.runId,
      tool: req.tool,
      input: req.input,
      status: 'pending',
      reason: req.reason ?? '',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.items.push(item);
    return item;
  }

  async pending(): Promise<ConfirmationRequest[]> {
    return this.items.filter((i) => i.status === 'pending');
  }

  async resolve(
    id: string,
    status: 'approved' | 'denied',
    resolvedBy: string,
  ): Promise<ConfirmationRequest | null> {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'pending') return null;
    item.status = status;
    item.resolvedAt = new Date().toISOString();
    item.resolvedBy = resolvedBy;
    return item;
  }
}
