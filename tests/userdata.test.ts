/**
 * Phase 5 hardening — notification history, tasks, and persisted tool permissions.
 * Deterministic and offline: in-memory stores, the tools over those stores, the
 * Pg stores over a fake Db (SQL/param shape), and the API routes via ApiHandler.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db, QueryResult } from '../src/db/client.js';
import {
  InMemoryNotificationStore,
  PgNotificationStore,
} from '../src/notifications/store.js';
import { InMemoryTaskStore, PgTaskStore } from '../src/tasks/store.js';
import {
  InMemoryToolPermissionStore,
  PgToolPermissionStore,
} from '../src/tools/permissions.js';
import { createNotifyTool } from '../src/tools/builtin/notify.js';
import { createTaskTools } from '../src/tools/builtin/tasks.js';
import { ApiHandler, type ApiDeps, type ApiRequest } from '../src/server/api.js';
import { InMemoryActivityFeed, InMemoryKillSwitch } from '../src/autonomy/store.js';
import { InMemoryConfirmationQueue, InMemoryRulesStore } from '../src/safety/store.js';
import { InMemoryStructuredStore } from '../src/memory/stores.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { AgentInput, AgentRunResult, Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-userdata' };

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

describe('InMemoryNotificationStore', () => {
  it('adds, lists newest-first, tracks unread, and marks read', async () => {
    const store = new InMemoryNotificationStore();
    await store.add({ title: 'first', body: 'a' });
    const second = await store.add({ title: 'second', body: 'b', urgency: 'high' });

    const recent = await store.recent();
    assert.equal(recent[0]!.title, 'second');
    assert.equal(recent[0]!.urgency, 'high');
    assert.equal(await store.unreadCount(), 2);

    const read = await store.markRead(second.id);
    assert.ok(read!.readAt);
    assert.equal(await store.unreadCount(), 1);
    assert.equal(await store.markRead('nope'), null);
  });
});

describe('notify tool records history', () => {
  it('delivers and persists to the store with the run id', async () => {
    const store = new InMemoryNotificationStore();
    const notify = createNotifyTool({ store });
    const res = await notify.execute({ title: 'Briefing', body: 'all clear', urgency: 'low' }, ctx);
    assert.equal(res.ok, true);
    const [recorded] = await store.recent();
    assert.equal(recorded!.title, 'Briefing');
    assert.equal(recorded!.urgency, 'low');
    assert.equal(recorded!.sourceRun, 'run-userdata');
  });

  it('still delivers when no store is configured', async () => {
    const res = await createNotifyTool().execute({ title: 'x', body: 'y' }, ctx);
    assert.equal(res.ok, true);
  });
});

describe('InMemoryTaskStore', () => {
  it('creates, lists, filters, updates status with completedAt, and removes', async () => {
    const store = new InMemoryTaskStore();
    const a = await store.create({ title: 'write spec', priority: 'high' });
    await store.create({ title: 'review pr' });

    assert.equal((await store.list()).length, 2);
    assert.equal(a.completedAt, null);

    const done = await store.update(a.id, { status: 'done' });
    assert.equal(done!.status, 'done');
    assert.ok(done!.completedAt, 'completedAt should be stamped');

    const reopened = await store.update(a.id, { status: 'todo' });
    assert.equal(reopened!.completedAt, null, 'completedAt cleared when reopened');

    assert.deepEqual((await store.list({ status: ['done'] })).map((t) => t.id), []);
    assert.equal(await store.remove(a.id), true);
    assert.equal((await store.list()).length, 1);
  });
});

describe('task tools', () => {
  it('create_task / list_tasks / update_task over the store', async () => {
    const store = new InMemoryTaskStore();
    const tools = createTaskTools(store);
    const create = byName(tools, 'create_task');
    const list = byName(tools, 'list_tasks');
    const update = byName(tools, 'update_task');

    assert.equal(create.kind, 'state_mutating');
    assert.equal(list.kind, 'read_only');
    assert.equal(update.kind, 'state_mutating');

    const created = await create.execute({ title: 'ship it', priority: 'urgent' }, ctx);
    assert.equal(created.ok, true);
    const id = (created.data as { id: string }).id;

    const listed = await list.execute({}, ctx);
    assert.match(listed.content, /ship it/);

    const updated = await update.execute({ id, status: 'done' }, ctx);
    assert.equal(updated.ok, true);
    assert.match(updated.content, /done/);

    const missing = await update.execute({ id: 'nope', status: 'done' }, ctx);
    assert.equal(missing.ok, false);
  });

  it('rejects an invalid due date', async () => {
    const create = byName(createTaskTools(new InMemoryTaskStore()), 'create_task');
    const res = await create.execute({ title: 't', due_at: 'not-a-date' }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /not a valid date/);
  });
});

describe('InMemoryToolPermissionStore', () => {
  it('reports only disabled tools', async () => {
    const store = new InMemoryToolPermissionStore();
    await store.setEnabled('run_command', false);
    await store.setEnabled('web_fetch', true);
    assert.deepEqual(await store.disabledTools(), ['run_command']);
  });
});

describe('Pg stores over a fake Db', () => {
  it('PgNotificationStore inserts with params and maps the row', async () => {
    const db = new FakeDb(() => [{
      id: 'n1', title: 't', body: 'b', urgency: 'high', source_run: 'r1',
      created_at: '2026-01-01T00:00:00Z', read_at: null,
    }]);
    const note = await new PgNotificationStore(db).add({ title: 't', body: 'b', urgency: 'high', sourceRun: 'r1' });
    assert.match(db.queries[0]!.sql, /insert into notifications/);
    assert.deepEqual(db.last(), ['t', 'b', 'high', 'r1']);
    assert.equal(note.sourceRun, 'r1');
    assert.equal(note.readAt, null);
  });

  it('PgTaskStore.update recomputes completed_at from status', async () => {
    const db = new FakeDb(() => [{
      id: 't1', title: 'x', status: 'done', priority: 'normal', detail: '', project: null,
      due_at: null, source_run: null, created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:00Z',
    }]);
    const task = await new PgTaskStore(db).update('t1', { status: 'done' });
    assert.match(db.queries[0]!.sql, /completed_at = case/);
    assert.equal(task!.status, 'done');
    assert.ok(task!.completedAt);
  });

  it('PgToolPermissionStore upserts on conflict', async () => {
    const db = new FakeDb(() => []);
    await new PgToolPermissionStore(db).setEnabled('run_command', false, 'ui');
    assert.match(db.queries[0]!.sql, /on conflict \(tool\) do update/);
    assert.deepEqual(db.last(), ['run_command', false, 'ui']);
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

function fakeAgent(): ApiDeps['agent'] {
  return {
    async run(input: AgentInput): Promise<AgentRunResult> {
      return { runId: 'r', finalText: `echo:${input.text}`, stopReason: 'completed', iterations: 1, toolCalls: [] };
    },
  };
}

function tool(name: string): Tool {
  return {
    name, description: 'x', kind: 'read_only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { return { ok: true, content: 'ok' }; },
  };
}

function build() {
  const notifications = new InMemoryNotificationStore();
  const tasks = new InMemoryTaskStore();
  const toolPermissions = new InMemoryToolPermissionStore();
  const registry = new ToolRegistry().register(tool('run_command'));
  const deps: ApiDeps = {
    agent: fakeAgent(),
    audit: new InMemoryAuditLog(),
    activityFeed: new InMemoryActivityFeed(),
    killSwitch: new InMemoryKillSwitch(),
    rules: new InMemoryRulesStore(),
    queue: new InMemoryConfirmationQueue(),
    structured: new InMemoryStructuredStore(),
    registry,
    notifications,
    tasks,
    toolPermissions,
  };
  return { handler: new ApiHandler(deps), notifications, tasks, toolPermissions, registry };
}

const req = (method: string, path: string, body?: unknown, query = ''): ApiRequest => ({
  method, path, query: new URLSearchParams(query), body,
});

describe('API: tasks, notifications, tool permissions', () => {
  it('creates, lists, updates, and deletes a task', async () => {
    const { handler } = build();
    const created = await handler.handle(req('POST', '/api/tasks', { title: 'do the thing', priority: 'high' }));
    assert.equal(created.status, 200);
    const id = (created.body as { task: { id: string } }).task.id;

    const listed = await handler.handle(req('GET', '/api/tasks'));
    assert.equal((listed.body as { tasks: unknown[] }).tasks.length, 1);

    const updated = await handler.handle(req('POST', `/api/tasks/${id}`, { status: 'done' }));
    assert.equal((updated.body as { task: { status: string } }).task.status, 'done');

    const todos = await handler.handle(req('GET', '/api/tasks', undefined, 'status=todo'));
    assert.equal((todos.body as { tasks: unknown[] }).tasks.length, 0);

    const removed = await handler.handle(req('DELETE', `/api/tasks/${id}`));
    assert.equal(removed.status, 200);
  });

  it('validates task input', async () => {
    const { handler } = build();
    assert.equal((await handler.handle(req('POST', '/api/tasks', {}))).status, 400);
    assert.equal((await handler.handle(req('POST', '/api/tasks', { title: 'x', priority: 'bogus' }))).status, 400);
    assert.equal((await handler.handle(req('GET', '/api/tasks', undefined, 'status=bogus'))).status, 400);
  });

  it('lists notifications with an unread count and marks one read', async () => {
    const { handler, notifications } = build();
    const note = await notifications.add({ title: 'hi', body: 'there' });
    const listed = await handler.handle(req('GET', '/api/notifications'));
    assert.equal((listed.body as { unread: number }).unread, 1);

    const read = await handler.handle(req('POST', `/api/notifications/${note.id}/read`));
    assert.equal(read.status, 200);
    const after = await handler.handle(req('GET', '/api/notifications'));
    assert.equal((after.body as { unread: number }).unread, 0);
  });

  it('persists a tool toggle through the permission store', async () => {
    const { handler, toolPermissions, registry } = build();
    const res = await handler.handle(req('POST', '/api/tools/run_command', { enabled: false }));
    assert.equal(res.status, 200);
    assert.equal(registry.isEnabled('run_command'), false);
    assert.deepEqual(await toolPermissions.disabledTools(), ['run_command']);
  });
});
