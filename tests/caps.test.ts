/**
 * Durable spend caps — the Postgres-backed cost ledger (migrations/0004).
 *
 * Offline: PgCostLedger is exercised against a fake {@link Db} that records the
 * SQL it's handed (asserting the INSERT/SELECT shape + numeric parsing) and, in a
 * stateful variant, actually accumulates rows so the SpendCapEnforcer's rolling
 * window can be driven end-to-end without a real database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db, QueryResult } from '../src/db/client.js';
import { PgCostLedger } from '../src/safety/pgStore.js';
import { SpendCapEnforcer, type SpendConfig } from '../src/safety/caps.js';
import type { Tool } from '../src/types.js';

/** Records every query; returns canned rows keyed by a matcher. */
class RecordingDb implements Db {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly canned: (sql: string) => unknown[] = () => []) {}
  async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.queries.push({ sql, params });
    const rows = this.canned(sql) as R[];
    return { rows, rowCount: rows.length };
  }
  async close(): Promise<void> {}
}

/** A fake Db that actually stores ledger rows and answers the sum query. */
class StatefulLedgerDb implements Db {
  private readonly rows: { ts: Date; amount: number }[] = [];
  async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    if (/insert into cost_ledger/i.test(sql)) {
      this.rows.push({ ts: params[0] as Date, amount: Number(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (/sum\(amount\)/i.test(sql)) {
      const since = params[0] as Date;
      const total = this.rows
        .filter((r) => r.ts.getTime() >= since.getTime())
        .reduce((s, r) => s + r.amount, 0);
      // pg returns numeric as a string — mimic that to test parsing.
      return { rows: [{ total: String(total) }] as R[], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  async close(): Promise<void> {}
}

function tool(name: string): Tool {
  return {
    name,
    description: 'x',
    kind: 'state_mutating',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() { return { ok: true, content: 'ok' }; },
  };
}

const baseConfig: SpendConfig = {
  rollingWindowMs: 60 * 60 * 1000,
  costFields: { pay: 'amount' },
  tradeToolMarkers: [],
};

describe('PgCostLedger', () => {
  it('inserts a cost row with a Date timestamp', async () => {
    const db = new RecordingDb();
    const ledger = new PgCostLedger(db);
    await ledger.record({ ts: 1_700_000_000_000, tool: 'pay', amount: 42.5 });

    assert.equal(db.queries.length, 1);
    assert.match(db.queries[0]!.sql, /insert into cost_ledger/i);
    const [ts, name, amount] = db.queries[0]!.params;
    assert.ok(ts instanceof Date);
    assert.equal((ts as Date).getTime(), 1_700_000_000_000);
    assert.equal(name, 'pay');
    assert.equal(amount, 42.5);
  });

  it('sums the window and parses pg numeric strings into a number', async () => {
    const db = new RecordingDb((sql) => (/sum\(amount\)/i.test(sql) ? [{ total: '137.5000' }] : []));
    const ledger = new PgCostLedger(db);
    const total = await ledger.totalSince(1_700_000_000_000);

    assert.strictEqual(total, 137.5);
    assert.match(db.queries[0]!.sql, /where ts >= \$1/i);
    assert.ok(db.queries[0]!.params[0] instanceof Date);
  });

  it('returns 0 (number) when the window is empty', async () => {
    // coalesce(...,0) returns "0"; ensure we never leak a string back to the caps.
    const ledger = new PgCostLedger(new RecordingDb(() => [{ total: '0' }]));
    assert.strictEqual(await ledger.totalSince(0), 0);
  });
});

describe('SpendCapEnforcer over the durable ledger', () => {
  it('accumulates committed spend and denies the call that breaches the rolling limit', async () => {
    const ledger = new PgCostLedger(new StatefulLedgerDb());
    const enforcer = new SpendCapEnforcer({ ...baseConfig, rollingLimit: 100 }, ledger);
    const pay = tool('pay');

    assert.equal((await enforcer.check(pay, { amount: 60 })).ok, true);
    await enforcer.commit(pay, { amount: 60 });

    // 60 already in the window; another 60 would total 120 > 100.
    const second = await enforcer.check(pay, { amount: 60 });
    assert.equal(second.ok, false);
    assert.match(second.reason, /rolling limit 100 \(already 60/);

    // A smaller call that stays under the limit is still allowed.
    assert.equal((await enforcer.check(pay, { amount: 30 })).ok, true);
  });
});
