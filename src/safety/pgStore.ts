/**
 * Postgres-backed safety stores — the durable path for standing rules and the
 * confirmation queue (schema in migrations/0002). Thin SQL; all matching logic
 * stays in store.ts.
 */

import type { Db } from '../db/client.js';
import type { CostLedger, LedgerEntry } from './caps.js';
import type {
  ConfirmationQueueStore,
  ConfirmationRequest,
  ConfirmationStatus,
  NewStandingRule,
  RuleEffect,
  StandingRule,
  StandingRulesStore,
} from './store.js';

export class PgRulesStore implements StandingRulesStore {
  constructor(private readonly db: Db) {}

  async findForTool(tool: string): Promise<StandingRule[]> {
    const res = await this.db.query<RuleRow>(
      `select * from standing_rules
        where enabled
          and (tool = $1 or tool = '*')
          and (expires_at is null or expires_at > now())`,
      [tool],
    );
    return res.rows.map(toRule);
  }

  async add(rule: NewStandingRule): Promise<StandingRule> {
    const res = await this.db.query<RuleRow>(
      `insert into standing_rules (tool, match, effect, reason, expires_at)
       values ($1, $2, $3, $4, $5) returning *`,
      [rule.tool, JSON.stringify(rule.match ?? {}), rule.effect, rule.reason ?? '', rule.expiresAt ?? null],
    );
    return toRule(res.rows[0]!);
  }

  async list(): Promise<StandingRule[]> {
    const res = await this.db.query<RuleRow>(
      `select * from standing_rules order by created_at desc`,
    );
    return res.rows.map(toRule);
  }
}

export class PgConfirmationQueue implements ConfirmationQueueStore {
  constructor(private readonly db: Db) {}

  async enqueue(req: {
    runId: string;
    tool: string;
    input: unknown;
    reason?: string;
  }): Promise<ConfirmationRequest> {
    const res = await this.db.query<QueueRow>(
      `insert into confirmation_queue (run_id, tool, input, reason)
       values ($1, $2, $3, $4) returning *`,
      [req.runId, req.tool, JSON.stringify(req.input), req.reason ?? ''],
    );
    return toRequest(res.rows[0]!);
  }

  async pending(): Promise<ConfirmationRequest[]> {
    const res = await this.db.query<QueueRow>(
      `select * from confirmation_queue where status = 'pending' order by created_at`,
    );
    return res.rows.map(toRequest);
  }

  async resolve(
    id: string,
    status: 'approved' | 'denied',
    resolvedBy: string,
  ): Promise<ConfirmationRequest | null> {
    const res = await this.db.query<QueueRow>(
      `update confirmation_queue
          set status = $2, resolved_at = now(), resolved_by = $3
        where id = $1 and status = 'pending'
        returning *`,
      [id, status, resolvedBy],
    );
    return res.rows[0] ? toRequest(res.rows[0]) : null;
  }
}

/**
 * Postgres-backed spend ledger (schema in migrations/0004). Makes the
 * SpendCapEnforcer's rolling window durable: committed costs are appended and the
 * window total is summed in the database, so it survives restarts. Epoch-ms
 * timestamps are mapped to/from `timestamptz` at the boundary.
 */
export class PgCostLedger implements CostLedger {
  constructor(private readonly db: Db) {}

  async record(entry: LedgerEntry): Promise<void> {
    await this.db.query(
      `insert into cost_ledger (ts, tool, amount) values ($1, $2, $3)`,
      [new Date(entry.ts), entry.tool, entry.amount],
    );
  }

  async totalSince(since: number): Promise<number> {
    const res = await this.db.query<{ total: string | number | null }>(
      `select coalesce(sum(amount), 0) as total from cost_ledger where ts >= $1`,
      [new Date(since)],
    );
    // numeric sums come back as strings from `pg`; normalize to a number.
    const total = res.rows[0]?.total ?? 0;
    return typeof total === 'number' ? total : Number(total);
  }
}

interface RuleRow {
  id: string;
  tool: string;
  match: Record<string, unknown>;
  effect: RuleEffect;
  reason: string;
  enabled: boolean;
  created_at: string;
  expires_at: string | null;
}

interface QueueRow {
  id: string;
  run_id: string;
  tool: string;
  input: unknown;
  status: ConfirmationStatus;
  reason: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function toRule(r: RuleRow): StandingRule {
  return {
    id: r.id,
    tool: r.tool,
    match: r.match ?? {},
    effect: r.effect,
    reason: r.reason,
    enabled: r.enabled,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}

function toRequest(r: QueueRow): ConfirmationRequest {
  return {
    id: r.id,
    runId: r.run_id,
    tool: r.tool,
    input: r.input,
    status: r.status,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolvedBy: r.resolved_by,
  };
}
