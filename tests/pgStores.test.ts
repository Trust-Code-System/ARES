/**
 * Postgres store impls over a programmable fake {@link Db} — offline.
 *
 * These thin SQL wrappers can't reach a real database in CI, so each test pins
 * the two things that can silently rot without one: the parameters handed to the
 * query (shape, order, normalization) and the row→domain mapping on the way back.
 * The SQL text itself is spot-checked for the clauses that carry meaning.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db, QueryResult } from '../src/db/client.js';
import { PgRulesStore, PgConfirmationQueue } from '../src/safety/pgStore.js';
import { PgSemanticStore, PgStructuredStore } from '../src/memory/pgStores.js';
import { PgKillSwitch, PgActivityFeed } from '../src/autonomy/pgStore.js';

/** Fake Db that records every query and returns rows from a SQL-aware responder. */
class FakeDb implements Db {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly responder: (sql: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.queries.push({ sql, params });
    const rows = this.responder(sql, params) as R[];
    return { rows, rowCount: rows.length };
  }
  async close(): Promise<void> {}
  /** The most recent query's params. */
  last(): unknown[] { return this.queries.at(-1)!.params; }
}

describe('PgRulesStore', () => {
  it('finds rules for a tool (incl. wildcard + unexpired) and maps the row', async () => {
    const db = new FakeDb(() => [{
      id: 'r1', tool: '*', match: { to: 'a@b.com' }, effect: 'allow',
      reason: 'ok', enabled: true, created_at: '2026-01-01T00:00:00Z', expires_at: null,
    }]);
    const rules = await new PgRulesStore(db).findForTool('send_email');

    assert.deepEqual(db.last(), ['send_email']);
    assert.match(db.queries[0]!.sql, /tool = \$1 or tool = '\*'/);
    assert.match(db.queries[0]!.sql, /expires_at is null or expires_at > now\(\)/);
    assert.deepEqual(rules[0]!.match, { to: 'a@b.com' });
    assert.equal(rules[0]!.effect, 'allow');
    assert.equal(rules[0]!.expiresAt, null);
  });

  it('serializes match to JSON on add', async () => {
    const db = new FakeDb(() => [{
      id: 'r2', tool: 'notify', match: {}, effect: 'allow', reason: '', enabled: true,
      created_at: '2026-01-01T00:00:00Z', expires_at: null,
    }]);
    await new PgRulesStore(db).add({ tool: 'notify', match: { x: 1 }, effect: 'allow' });
    assert.match(db.queries[0]!.sql, /insert into standing_rules/);
    assert.equal(db.last()[1], JSON.stringify({ x: 1 }));
  });
});

describe('PgConfirmationQueue', () => {
  const row = {
    id: 'c1', run_id: 'run9', tool: 'send_email', input: { to: 'x' }, status: 'pending',
    reason: '', created_at: '2026-01-01T00:00:00Z', resolved_at: null, resolved_by: null,
  };

  it('enqueues with serialized input and maps run_id → runId', async () => {
    const db = new FakeDb(() => [row]);
    const req = await new PgConfirmationQueue(db).enqueue({ runId: 'run9', tool: 'send_email', input: { to: 'x' } });
    assert.match(db.queries[0]!.sql, /insert into confirmation_queue/);
    assert.equal(db.last()[2], JSON.stringify({ to: 'x' }));
    assert.equal(req.runId, 'run9');
    assert.equal(req.status, 'pending');
  });

  it('resolve returns null when no pending row matched', async () => {
    const db = new FakeDb(() => []); // update matched nothing
    const resolved = await new PgConfirmationQueue(db).resolve('missing', 'approved', 'ui');
    assert.equal(resolved, null);
    assert.match(db.queries[0]!.sql, /update confirmation_queue/);
    assert.deepEqual(db.last(), ['missing', 'approved', 'ui']);
  });
});

describe('PgSemanticStore', () => {
  it('inserts each chunk with a pgvector literal + JSON metadata', async () => {
    const db = new FakeDb();
    await new PgSemanticStore(db).add(
      [{ sourceType: 'conversation', content: 'hi', metadata: { a: 1 } }],
      [[0.1, 0.2, 0.3]],
    );
    assert.match(db.queries[0]!.sql, /insert into semantic_memory/);
    const p = db.last();
    assert.equal(p[3], '[0.1,0.2,0.3]'); // vector literal
    assert.equal(p[4], JSON.stringify({ a: 1 }));
  });

  it('searches by cosine distance, passing the query vector + k + threshold, and maps similarity', async () => {
    const db = new FakeDb(() => [{
      id: 's1', source_type: 'conversation', source_ref: null, content: 'hi',
      metadata: {}, importance: 0.5, created_at: '2026-01-01T00:00:00Z', similarity: 0.91,
    }]);
    const hits = await new PgSemanticStore(db).search([1, 0], 5, 0.2);
    assert.match(db.queries[0]!.sql, /embedding <=> \$1/);
    assert.deepEqual(db.last(), ['[1,0]', 5, 0.2]);
    assert.equal(hits[0]!.similarity, 0.91);
    assert.equal(hits[0]!.sourceType, 'conversation');
  });
});

describe('PgStructuredStore', () => {
  const row = {
    id: 'f1', kind: 'fact', subject: 'user', content: 'likes tea', attributes: {},
    confidence: 1, importance: 0.5, source_run: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  };

  it('upserts with a normalized dedupe key and on-conflict merge', async () => {
    const db = new FakeDb(() => [row]);
    await new PgStructuredStore(db).upsert({ kind: 'fact', subject: '  User ', content: 'Likes   Tea', attributes: {} });
    assert.match(db.queries[0]!.sql, /on conflict \(dedupe_key\) do update/);
    assert.equal(db.last()[7], 'fact:user:likes tea'); // normalized key
  });

  it('passes the optional kind filter as a text[] (or null)', async () => {
    const db = new FakeDb(() => [row]);
    const store = new PgStructuredStore(db);
    await store.search('tea', 10, ['fact', 'preference']);
    assert.deepEqual(db.last(), ['tea', 10, ['fact', 'preference']]);
    await store.search('tea', 10);
    assert.deepEqual(db.last(), ['tea', 10, null]);
  });
});

describe('PgKillSwitch', () => {
  it('maps the singleton row and falls back to "running" when absent', async () => {
    const present = new PgKillSwitch(new FakeDb(() => [{
      engaged: true, reason: 'pause', changed_at: '2026-01-01T00:00:00Z', changed_by: 'ui',
    }]));
    const s = await present.state();
    assert.equal(s.engaged, true);
    assert.equal(s.reason, 'pause');

    const absent = new PgKillSwitch(new FakeDb(() => []));
    assert.equal((await absent.state()).engaged, false);
  });

  it('engages with reason + actor params', async () => {
    const db = new FakeDb(() => [{ engaged: true, reason: 'r', changed_at: '2026-01-01T00:00:00Z', changed_by: 'cli' }]);
    await new PgKillSwitch(db).engage('r', 'cli');
    assert.match(db.queries[0]!.sql, /set engaged = true/);
    assert.deepEqual(db.last(), ['r', 'cli']);
  });
});

describe('PgActivityFeed', () => {
  const row = {
    id: 'a1', trigger: 'schedule:test', run_id: null, status: 'running',
    detail: '', started_at: '2026-01-01T00:00:00Z', finished_at: null,
  };

  it('starts a record in the running state', async () => {
    const db = new FakeDb(() => [row]);
    const rec = await new PgActivityFeed(db).start({ trigger: 'schedule:test' });
    assert.match(db.queries[0]!.sql, /insert into activity_feed/);
    assert.equal(rec.status, 'running');
    assert.equal(rec.runId, null);
  });

  it('finish coalesces omitted fields and returns null when the id is unknown', async () => {
    const db = new FakeDb(() => []);
    const res = await new PgActivityFeed(db).finish('nope', { status: 'completed' });
    assert.equal(res, null);
    assert.match(db.queries[0]!.sql, /coalesce\(\$3, detail\)/);
    assert.deepEqual(db.last(), ['nope', 'completed', null, null]);
  });

  it('recent passes the limit through', async () => {
    const db = new FakeDb(() => [row]);
    await new PgActivityFeed(db).recent(7);
    assert.deepEqual(db.last(), [7]);
  });
});
