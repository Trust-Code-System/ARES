/**
 * Spend & trade hard caps — money limits enforced in CODE, never via the prompt.
 *
 * The {@link SpendCapEnforcer} is consulted by the confirmation gate BEFORE any
 * other decision (before mode short-circuits, standing rules, or a human). A call
 * that would breach a cap is denied outright — there is no "auto-approve" or
 * standing rule that can override a cap, which is the whole point: the model
 * cannot talk its way past a money limit.
 *
 * Three limits, all optional (a limit left unset is not enforced):
 *   - perActionLimit  — max cost of a single tool call.
 *   - rollingLimit    — max cumulative cost within a sliding window (e.g. 24h).
 *   - tradeNotionalCap — a stricter per-action ceiling for trade tools.
 *
 * A call's cost is read from its input via {@link SpendConfig.costFields}
 * (tool name → the numeric input field holding the amount). Tools not listed cost
 * 0 and are never capped. The cost is committed to a {@link CostLedger} only when
 * the call is approved, so the rolling window reflects intended spend.
 *
 * The {@link CostLedger} is the one piece that needs durability: {@link
 * InMemoryCostLedger} resets the rolling window on restart, whereas the
 * Postgres-backed `PgCostLedger` (src/safety/pgStore.ts, migration 0004) makes it
 * survive restarts. The enforcer itself is pure and fully testable with either.
 */

import type { Tool } from '../types.js';

export interface SpendConfig {
  perActionLimit?: number;
  rollingLimit?: number;
  rollingWindowMs: number;
  tradeNotionalCap?: number;
  /** tool name → input field holding the numeric amount for that call. */
  costFields: Record<string, string>;
  /** Substrings that mark a tool as a "trade" (subject to tradeNotionalCap). */
  tradeToolMarkers: string[];
}

export interface LedgerEntry {
  ts: number;
  tool: string;
  amount: number;
}

export interface CostLedger {
  record(entry: LedgerEntry): Promise<void>;
  /** Total amount recorded at or after `since` (epoch ms). */
  totalSince(since: number): Promise<number>;
}

export class InMemoryCostLedger implements CostLedger {
  private readonly entries: LedgerEntry[] = [];

  async record(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  async totalSince(since: number): Promise<number> {
    return this.entries.filter((e) => e.ts >= since).reduce((sum, e) => sum + e.amount, 0);
  }
}

export interface CapDecision {
  ok: boolean;
  reason: string;
}

export class SpendCapEnforcer {
  constructor(
    private readonly config: SpendConfig,
    private readonly ledger: CostLedger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read the monetary cost of a call from its declared cost field (0 if none). */
  cost(tool: Tool, input: unknown): number {
    const field = this.config.costFields[tool.name];
    if (!field) return 0;
    const value = (input as Record<string, unknown> | null)?.[field];
    const amount = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  private isTrade(tool: Tool): boolean {
    const name = tool.name.toLowerCase();
    return this.config.tradeToolMarkers.some((m) => name.includes(m));
  }

  /** Decide whether a call is within all configured caps. Does not record it. */
  async check(tool: Tool, input: unknown): Promise<CapDecision> {
    const amount = this.cost(tool, input);
    if (amount <= 0) return { ok: true, reason: 'no cost' };

    if (this.isTrade(tool) && this.config.tradeNotionalCap !== undefined && amount > this.config.tradeNotionalCap) {
      return { ok: false, reason: `trade notional ${amount} exceeds hard cap ${this.config.tradeNotionalCap}` };
    }
    if (this.config.perActionLimit !== undefined && amount > this.config.perActionLimit) {
      return { ok: false, reason: `cost ${amount} exceeds per-action limit ${this.config.perActionLimit}` };
    }
    if (this.config.rollingLimit !== undefined) {
      const since = this.now() - this.config.rollingWindowMs;
      const spent = await this.ledger.totalSince(since);
      if (spent + amount > this.config.rollingLimit) {
        return {
          ok: false,
          reason: `cost ${amount} would exceed rolling limit ${this.config.rollingLimit} (already ${spent} in window)`,
        };
      }
    }
    return { ok: true, reason: `within caps (cost ${amount})` };
  }

  /** Record an approved call's cost so it counts toward the rolling window. */
  async commit(tool: Tool, input: unknown): Promise<void> {
    const amount = this.cost(tool, input);
    if (amount > 0) await this.ledger.record({ ts: this.now(), tool: tool.name, amount });
  }
}

/** Default cost-field map for the trading/payment tools ARES may gain. */
export const DEFAULT_COST_FIELDS: Record<string, string> = {
  place_trade: 'notional',
  trade: 'notional',
  pay: 'amount',
  spend: 'amount',
  transfer: 'amount',
};

export const DEFAULT_TRADE_MARKERS = ['trade'];
