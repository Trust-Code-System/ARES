/**
 * Phase 5 — API surface. Deterministic and offline: the ApiHandler is exercised
 * directly (no sockets) against in-memory backends and a fake agent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { ApiHandler, type ApiDeps, type ApiRequest } from '../src/server/api.js';
import { InMemoryActivityFeed, InMemoryKillSwitch } from '../src/autonomy/store.js';
import { InMemoryConfirmationQueue, InMemoryRulesStore, evaluateRules } from '../src/safety/store.js';
import { InMemoryStructuredStore, InMemorySemanticStore } from '../src/memory/stores.js';
import { HashEmbeddingClient } from '../src/memory/embeddings.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { AgentInput, AgentRunResult, Tool } from '../src/types.js';

function fakeAgent(audit: InMemoryAuditLog): ApiDeps['agent'] {
  return {
    async run(input: AgentInput): Promise<AgentRunResult> {
      const runId = 'run-api';
      audit.record({
        runId,
        ts: new Date().toISOString(),
        type: 'run_started',
        detail: { text: input.text, mode: input.mode ?? 'general', history: input.history?.length ?? 0 },
      });
      return { runId, finalText: `echo: ${input.text}`, stopReason: 'completed', iterations: 1, toolCalls: [] };
    },
  };
}

function tool(name: string): Tool {
  return {
    name,
    description: 'x',
    kind: 'read_only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { return { ok: true, content: 'ok' }; },
  };
}

function build(opts: { semantic?: boolean } = {}) {
  const audit = new InMemoryAuditLog();
  const registry = new ToolRegistry().register(tool('web_fetch')).register(tool('notify'));
  const semantic = new InMemorySemanticStore();
  const embeddings = new HashEmbeddingClient(64);
  const deps: ApiDeps = {
    agent: fakeAgent(audit),
    audit,
    activityFeed: new InMemoryActivityFeed(),
    killSwitch: new InMemoryKillSwitch(),
    rules: new InMemoryRulesStore(),
    queue: new InMemoryConfirmationQueue(),
    structured: new InMemoryStructuredStore(),
    registry,
    ...(opts.semantic ? { semantic, embeddings } : {}),
  };
  return { handler: new ApiHandler(deps), deps, semantic, embeddings };
}

const req = (method: string, path: string, body?: unknown, query = ''): ApiRequest => ({
  method,
  path,
  query: new URLSearchParams(query),
  body,
});

describe('ApiHandler', () => {
  it('runs a chat turn and returns the answer plus the run audit events', async () => {
    const { handler } = build();
    const res = await handler.handle(req('POST', '/api/chat', { text: 'hi' }));
    assert.equal(res.status, 200);
    const body = res.body as { finalText: string; runId: string; events: unknown[] };
    assert.equal(body.finalText, 'echo: hi');
    assert.equal(body.runId, 'run-api');
    assert.ok(body.events.length >= 1);
  });

  it('400s a chat with no text and 404s an unknown route', async () => {
    const { handler } = build();
    assert.equal((await handler.handle(req('POST', '/api/chat', {}))).status, 400);
    assert.equal((await handler.handle(req('GET', '/api/nope'))).status, 404);
  });

  it('accepts a specialist mode, rejects invalid modes, and reports runtime status', async () => {
    const { handler } = build();
    const valid = await handler.handle(req('POST', '/api/chat', {
      text: 'review this',
      mode: 'design',
      history: [{ role: 'user', content: 'previous context' }],
    }));
    assert.equal(valid.status, 200);
    const events = (valid.body as { events: Array<{ detail: { mode?: string } }> }).events;
    assert.equal(events[0]?.detail.mode, 'design');
    assert.equal((events[0]?.detail as { history?: number }).history, 1);

    const invalid = await handler.handle(req('POST', '/api/chat', { text: 'hello', mode: 'wizard' }));
    assert.equal(invalid.status, 400);

    const status = await handler.handle(req('GET', '/api/status'));
    assert.equal(status.status, 200);
    assert.equal(typeof (status.body as { voiceEnabled: boolean }).voiceEnabled, 'boolean');
    const capabilities = (status.body as { capabilities: unknown[] }).capabilities;
    assert.ok(Array.isArray(capabilities));
    assert.equal(capabilities.length, 23);
  });

  it('reads and flips the kill switch', async () => {
    const { handler } = build();
    assert.equal(((await handler.handle(req('GET', '/api/killswitch'))).body as { state: { engaged: boolean } }).state.engaged, false);
    const engaged = await handler.handle(req('POST', '/api/killswitch', { engaged: true, reason: 'pause' }));
    assert.equal((engaged.body as { state: { engaged: boolean; reason: string } }).state.engaged, true);
    assert.equal((engaged.body as { state: { reason: string } }).state.reason, 'pause');
  });

  it('lists tools and toggles one off', async () => {
    const { handler, deps } = build();
    const before = (await handler.handle(req('GET', '/api/tools'))).body as { tools: Array<{ name: string; enabled: boolean }> };
    assert.ok(before.tools.find((t) => t.name === 'web_fetch')?.enabled);

    const toggled = await handler.handle(req('POST', '/api/tools/web_fetch', { enabled: false }));
    assert.equal(toggled.status, 200);
    assert.equal(deps.registry.isEnabled('web_fetch'), false);
    // A disabled tool is no longer offered to the model.
    assert.equal(deps.registry.toAnthropicTools().some((t) => t.name === 'web_fetch'), false);

    const missing = await handler.handle(req('POST', '/api/tools/nope', { enabled: false }));
    assert.equal(missing.status, 404);
  });

  it('approves a queued confirmation', async () => {
    const { handler, deps } = build();
    const queued = await deps.queue.enqueue({ runId: 'r', tool: 'send_email', input: { to: 'a@b.com' } });
    const res = await handler.handle(req('POST', `/api/confirmations/${queued.id}`, { decision: 'approved' }));
    assert.equal(res.status, 200);
    assert.equal((await deps.queue.pending()).length, 0);

    const bad = await handler.handle(req('POST', `/api/confirmations/${queued.id}`, { decision: 'maybe' }));
    assert.equal(bad.status, 400);
  });

  it('runs a queued tool when the user approves it in chat, and cancels on deny', async () => {
    let opened: string | null = null;
    const openUrl: Tool = {
      name: 'open_url',
      description: 'open a url',
      kind: 'state_mutating',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
      async execute(input) {
        opened = (input as { url: string }).url;
        return { ok: true, content: `Opened ${opened}.`, data: { url: opened } };
      },
    };
    const audit = new InMemoryAuditLog();
    const deps: ApiDeps = {
      agent: fakeAgent(audit),
      audit,
      activityFeed: new InMemoryActivityFeed(),
      killSwitch: new InMemoryKillSwitch(),
      rules: new InMemoryRulesStore(),
      queue: new InMemoryConfirmationQueue(),
      structured: new InMemoryStructuredStore(),
      registry: new ToolRegistry().register(openUrl),
    };
    const handler = new ApiHandler(deps);

    await deps.queue.enqueue({ runId: 'r1', tool: 'open_url', input: { url: 'https://www.google.com' } });
    const res = await handler.handle(req('POST', '/api/chat', { text: 'approved' }));
    assert.equal(res.status, 200);
    const body = res.body as { finalText: string; toolCalls: Array<{ name: string; ok: boolean }> };
    assert.equal(opened, 'https://www.google.com');
    assert.match(body.finalText, /^Opened https:\/\/www\.google\.com\./);
    assert.deepEqual(body.toolCalls, [{ name: 'open_url', ok: true }]);
    assert.equal((await deps.queue.pending()).length, 0);

    // Approving remembers the exact input as a standing allow-rule: the identical
    // request is now pre-authorized, but a different URL is not.
    const rules = await deps.rules.findForTool('open_url');
    assert.equal(rules.length, 1);
    assert.equal(evaluateRules(rules, { url: 'https://www.google.com' })?.effect, 'allow');
    assert.equal(evaluateRules(rules, { url: 'https://evil.com' }), null);

    // "deny" cancels the pending request without running anything.
    await deps.queue.enqueue({ runId: 'r2', tool: 'open_url', input: { url: 'https://example.com' } });
    opened = null;
    const denied = await handler.handle(req('POST', '/api/chat', { text: 'cancel' }));
    assert.equal(opened, null);
    assert.match((denied.body as { finalText: string }).finalText, /won't run open_url/);
    assert.equal((await deps.queue.pending()).length, 0);

    // With nothing queued, "approved" is just a normal chat turn (no shortcut).
    const passthrough = await handler.handle(req('POST', '/api/chat', { text: 'approved' }));
    assert.equal((passthrough.body as { finalText: string }).finalText, 'echo: approved');
  });

  it('browses structured memory', async () => {
    const { handler, deps } = build();
    await deps.structured.upsert({ kind: 'fact', subject: 'user', content: 'likes tea', importance: 1, attributes: {} });
    const res = await handler.handle(req('GET', '/api/memory'));
    const body = res.body as { facts: unknown[] };
    assert.equal(body.facts.length, 1);
  });

  it('explicitly remembers and forgets a structured fact', async () => {
    const { handler } = build();
    const remembered = await handler.handle(req('POST', '/api/memory', {
      kind: 'project',
      subject: 'Atlas HR',
      content: 'Preserve requested document scope.',
    }));
    assert.equal(remembered.status, 200);
    const id = (remembered.body as { fact: { id: string } }).fact.id;

    const removed = await handler.handle(req('DELETE', `/api/memory/${id}`));
    assert.equal(removed.status, 200);
    const facts = (await handler.handle(req('GET', '/api/memory'))).body as { facts: unknown[] };
    assert.equal(facts.facts.length, 0);
  });

  it('browses semantic memory by embedding the query', async () => {
    const { handler, semantic, embeddings } = build({ semantic: true });
    const texts = ['the sailing trip to the coast was windy', 'quarterly budget spreadsheet review'];
    await semantic.add(
      texts.map((content) => ({ sourceType: 'conversation' as const, content })),
      await embeddings.embed(texts, 'document'),
    );

    const res = await handler.handle(req('GET', '/api/memory/semantic', undefined, 'q=sailing+coast+windy&limit=1'));
    assert.equal(res.status, 200);
    const body = res.body as { hits: Array<{ content: string; similarity: number }> };
    assert.equal(body.hits.length, 1);
    assert.match(body.hits[0]!.content, /sailing trip/);
    assert.ok(body.hits[0]!.similarity > 0);
  });

  it('requires q for semantic browse and degrades gracefully when not configured', async () => {
    const withSemantic = build({ semantic: true });
    assert.equal((await withSemantic.handler.handle(req('GET', '/api/memory/semantic'))).status, 400);

    const noSemantic = build(); // semantic store/embedder not wired
    const res = await noSemantic.handler.handle(req('GET', '/api/memory/semantic', undefined, 'q=anything'));
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as { hits: unknown[] }).hits, []);
  });

  it('rejects a skill import with no url or a non-GitHub url', async () => {
    const { handler } = build();
    assert.equal((await handler.handle(req('POST', '/api/skills/import', {}))).status, 400);
    const res = await handler.handle(req('POST', '/api/skills/import', { url: 'https://example.com/not-github' }));
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /github/i);
  });
});

describe('ApiHandler — managed MCP servers', () => {
  function mcpBuild() {
    const base = build();
    const configPath = path.join(os.tmpdir(), `ares-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const deps: ApiDeps = { ...base.deps, mcpConfigPath: configPath };
    return { handler: new ApiHandler(deps), configPath };
  }

  it('installs, lists, toggles, and removes an MCP server through the config store', async () => {
    const { handler, configPath } = mcpBuild();
    try {
      const empty = await handler.handle(req('GET', '/api/mcp'));
      assert.equal(empty.status, 200);
      assert.deepEqual((empty.body as { servers: unknown[] }).servers, []);

      const install = await handler.handle(
        req('POST', '/api/mcp/install', { name: 'Filesystem!', npmPackage: '@modelcontextprotocol/server-filesystem' }),
      );
      assert.equal(install.status, 200);
      assert.equal((install.body as { server: { name: string } }).server.name, 'filesystem');

      const listed = await handler.handle(req('GET', '/api/mcp'));
      const servers = (listed.body as { servers: Array<{ name: string; enabled: boolean; command: string }> }).servers;
      assert.equal(servers.length, 1);
      assert.equal(servers[0]!.enabled, false);
      assert.equal(servers[0]!.command, 'npx');

      const enabled = await handler.handle(req('POST', '/api/mcp/filesystem/enable'));
      assert.equal(enabled.status, 200);
      assert.equal((enabled.body as { enabled: boolean }).enabled, true);

      const removed = await handler.handle(req('DELETE', '/api/mcp/filesystem'));
      assert.equal(removed.status, 200);
      assert.equal((await handler.handle(req('GET', '/api/mcp'))).status, 200);
      assert.deepEqual(((await handler.handle(req('GET', '/api/mcp'))).body as { servers: unknown[] }).servers, []);
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('validates the install body and 404s unknown servers', async () => {
    const { handler, configPath } = mcpBuild();
    try {
      assert.equal((await handler.handle(req('POST', '/api/mcp/install', { name: 'x' }))).status, 400);
      assert.equal(
        (await handler.handle(req('POST', '/api/mcp/install', { name: 'x', npmPackage: 'a', command: 'b' }))).status,
        400,
      );
      assert.equal((await handler.handle(req('POST', '/api/mcp/ghost/enable'))).status, 404);
      assert.equal((await handler.handle(req('DELETE', '/api/mcp/ghost'))).status, 404);
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('reports MCP as unconfigured when no config path is wired', async () => {
    const { handler } = build();
    const res = await handler.handle(req('GET', '/api/mcp'));
    assert.equal(res.status, 200);
    assert.match((res.body as { note: string }).note, /not configured/i);
    assert.equal((await handler.handle(req('POST', '/api/mcp/install', { name: 'x', command: 'y' }))).status, 404);
  });
});
