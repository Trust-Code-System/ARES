/**
 * Phase 6 — the feedback engine: ratings/corrections, preference pairs, the
 * tools over the store, the Pg store's SQL/param shape over a fake Db, the API
 * routes via ApiHandler, and the DPO export of preference data.
 *
 * Deterministic and offline — no network, no real database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db, QueryResult } from '../src/db/client.js';
import {
  InMemoryFeedbackStore,
  PgFeedbackStore,
  type FeedbackStore,
} from '../src/feedback/store.js';
import { createFeedbackTools } from '../src/tools/builtin/feedback.js';
import { toDpoJsonl } from '../src/ai-training/export.js';
import type { PreferenceDataset } from '../src/ai-training/types.js';
import { ApiHandler, type ApiDeps, type ApiRequest } from '../src/server/api.js';
import { InMemoryActivityFeed, InMemoryKillSwitch } from '../src/autonomy/store.js';
import { InMemoryConfirmationQueue, InMemoryRulesStore } from '../src/safety/store.js';
import { InMemoryStructuredStore } from '../src/memory/stores.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { AgentInput, AgentRunResult, Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-feedback' };

class FakeDb implements Db {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  constructor(private readonly responder: (sql: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.queries.push({ sql, params });
    const rows = this.responder(sql, params) as R[];
    return { rows, rowCount: rows.length };
  }
  async close(): Promise<void> {}
  last(): unknown[] { return this.queries.at(-1)!.params; }
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

describe('InMemoryFeedbackStore', () => {
  it('records feedback, lists newest-first, and filters by rating', async () => {
    const store = new InMemoryFeedbackStore();
    await store.record({ rating: 1, note: 'great' });
    await store.record({ rating: -1, note: 'wrong', target: 'action' });

    const all = await store.list();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.note, 'wrong'); // newest first

    const down = await store.list({ rating: -1 });
    assert.equal(down.length, 1);
    assert.equal(down[0]!.target, 'action');
  });

  it('stores and filters preference pairs by source', async () => {
    const store = new InMemoryFeedbackStore();
    await store.addPreference({ prompt: 'p', chosen: 'a', rejected: 'b', source: 'ab_choice' });
    await store.addPreference({ prompt: 'q', chosen: 'c', rejected: 'd', source: 'correction' });

    assert.equal((await store.listPreferences()).length, 2);
    const corrections = await store.listPreferences({ source: 'correction' });
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]!.chosen, 'c');
  });
});

describe('feedback tools', () => {
  it('record_feedback with a full correction also logs a preference pair', async () => {
    const store = new InMemoryFeedbackStore();
    const tools = createFeedbackTools(store);
    const res = await byName(tools, 'record_feedback').execute(
      { rating: -1, note: 'too terse', prompt: 'summarize X', response: 'X is a thing.', correction: 'X is a detailed thing because…' },
      ctx,
    );
    assert.equal(res.ok, true);

    const prefs = await store.listPreferences();
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]!.source, 'correction');
    assert.equal(prefs[0]!.chosen, 'X is a detailed thing because…');
    assert.equal(prefs[0]!.rejected, 'X is a thing.');
  });

  it('record_feedback without both sides does NOT create a pair', async () => {
    const store = new InMemoryFeedbackStore();
    const tools = createFeedbackTools(store);
    await byName(tools, 'record_feedback').execute({ rating: 1, note: 'nice' }, ctx);
    assert.equal((await store.listPreferences()).length, 0);
  });

  it('record_preference stores an A/B choice', async () => {
    const store = new InMemoryFeedbackStore();
    const tools = createFeedbackTools(store);
    await byName(tools, 'record_preference').execute(
      { prompt: 'p', chosen: 'good', rejected: 'bad', reason: 'clearer' },
      ctx,
    );
    const prefs = await store.listPreferences();
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]!.source, 'ab_choice');
  });

  it('feedback tools are gated (state_mutating)', () => {
    const tools = createFeedbackTools(new InMemoryFeedbackStore());
    assert.equal(byName(tools, 'record_feedback').kind, 'state_mutating');
    assert.equal(byName(tools, 'record_preference').kind, 'state_mutating');
  });
});

describe('PgFeedbackStore SQL shape', () => {
  it('inserts feedback with the expected params', async () => {
    const db = new FakeDb((sql) =>
      sql.startsWith('insert')
        ? [{ id: 'f1', run_id: 'run-1', target: 'response', rating: 1, note: 'ok', correction: null, prompt: null, response: null, created_at: new Date().toISOString() }]
        : [],
    );
    const store = new PgFeedbackStore(db);
    const fb = await store.record({ rating: 1, note: 'ok', runId: 'run-1' });
    assert.equal(fb.id, 'f1');
    assert.deepEqual(db.last(), ['run-1', 'response', 1, 'ok', null, null, null]);
  });

  it('inserts a preference pair with the expected params', async () => {
    const db = new FakeDb((sql) =>
      sql.startsWith('insert')
        ? [{ id: 'p1', prompt: 'p', chosen: 'a', rejected: 'b', reason: 'r', source: 'manual', safety_label: null, created_at: new Date().toISOString() }]
        : [],
    );
    const store = new PgFeedbackStore(db);
    const pair = await store.addPreference({ prompt: 'p', chosen: 'a', rejected: 'b', reason: 'r' });
    assert.equal(pair.id, 'p1');
    assert.deepEqual(db.last(), ['p', 'a', 'b', 'r', 'manual', null]);
  });
});

describe('DPO export', () => {
  it('emits one {prompt, chosen, rejected} object per line and drops review metadata', () => {
    const ds: PreferenceDataset = {
      name: 'prefs',
      version: '1.0.0',
      examples: [
        { prompt: 'p1', chosen: 'good1', rejected: 'bad1', reason: 'should not appear' },
        { prompt: 'p2', chosen: 'good2', rejected: 'bad2', system: 'You are ARES.' },
      ],
    };
    const lines = toDpoJsonl(ds).split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { prompt: 'p1', chosen: 'good1', rejected: 'bad1' });
    assert.equal(lines[0].reason, undefined);
    assert.equal(lines[1].prompt, 'You are ARES.\n\np2'); // system folded into prompt
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function fakeAgent(): ApiDeps['agent'] {
  return {
    async run(input: AgentInput): Promise<AgentRunResult> {
      return { runId: 'r', finalText: `echo:${input.text}`, stopReason: 'completed', iterations: 1, toolCalls: [] };
    },
  };
}

function build(feedback: FeedbackStore) {
  const deps: ApiDeps = {
    agent: fakeAgent(),
    audit: new InMemoryAuditLog(),
    activityFeed: new InMemoryActivityFeed(),
    killSwitch: new InMemoryKillSwitch(),
    rules: new InMemoryRulesStore(),
    queue: new InMemoryConfirmationQueue(),
    structured: new InMemoryStructuredStore(),
    registry: new ToolRegistry(),
    feedback,
  };
  return new ApiHandler(deps);
}

const req = (method: string, path: string, body?: unknown, query = ''): ApiRequest => ({
  method, path, query: new URLSearchParams(query), body,
});

describe('API: feedback + preferences', () => {
  it('records feedback (with correction → preference) and lists it', async () => {
    const store = new InMemoryFeedbackStore();
    const handler = build(store);

    const posted = await handler.handle(
      req('POST', '/api/feedback', { rating: -1, prompt: 'p', response: 'bad', correction: 'good' }),
    );
    assert.equal(posted.status, 200);
    const body = posted.body as { feedback: { id: string }; preference?: { source: string } };
    assert.ok(body.feedback.id);
    assert.equal(body.preference?.source, 'correction');

    const listed = await handler.handle(req('GET', '/api/feedback'));
    assert.equal((listed.body as { feedback: unknown[] }).feedback.length, 1);

    const prefs = await handler.handle(req('GET', '/api/preferences'));
    assert.equal((prefs.body as { preferences: unknown[] }).preferences.length, 1);
  });

  it('rejects an invalid rating', async () => {
    const handler = build(new InMemoryFeedbackStore());
    const res = await handler.handle(req('POST', '/api/feedback', { rating: 5 }));
    assert.equal(res.status, 400);
  });

  it('records an explicit preference pair', async () => {
    const store = new InMemoryFeedbackStore();
    const handler = build(store);
    const res = await handler.handle(
      req('POST', '/api/preferences', { prompt: 'p', chosen: 'a', rejected: 'b', reason: 'clearer' }),
    );
    assert.equal(res.status, 200);
    assert.equal((await store.listPreferences())[0]!.chosen, 'a');
  });
});
