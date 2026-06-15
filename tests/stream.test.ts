/**
 * Phase 5 — the SSE chat stream (`POST /api/chat/stream`) over a real socket.
 *
 * Complements the orchestrator-level streaming test (phase1) by pinning the wire
 * format the browser actually parses: live `token` frames, cumulative `activity`
 * frames, a terminal `done`, and the `error` frame for an empty request. A fake
 * agent drives the {@link AgentEventHandlers} the server forwards, so it's
 * deterministic and offline.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiServer } from '../src/server/httpServer.js';
import type { ApiDeps } from '../src/server/api.js';
import { InMemoryActivityFeed, InMemoryKillSwitch } from '../src/autonomy/store.js';
import { InMemoryConfirmationQueue, InMemoryRulesStore } from '../src/safety/store.js';
import { InMemoryStructuredStore } from '../src/memory/stores.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { AgentInput, AgentRunResult, Logger } from '../src/types.js';

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

/** Agent that emits a couple of token deltas and a tool audit event, then finishes. */
function streamingAgent(): ApiDeps['agent'] {
  return {
    async run(input: AgentInput, _signal, events): Promise<AgentRunResult> {
      const runId = 'run-stream';
      const ts = new Date().toISOString();
      events?.onAudit?.({ runId, ts, type: 'run_started', detail: { text: input.text } });
      events?.onText?.('Hello ');
      events?.onText?.('world');
      events?.onAudit?.({ runId, ts, type: 'tool_executed', detail: { tool: 'calculate', ok: true } });
      return { runId, finalText: 'Hello world', stopReason: 'completed', iterations: 1, toolCalls: [{ name: 'calculate', ok: true }] };
    },
  };
}

function deps(): ApiDeps {
  return {
    agent: streamingAgent(),
    audit: new InMemoryAuditLog(),
    activityFeed: new InMemoryActivityFeed(),
    killSwitch: new InMemoryKillSwitch(),
    rules: new InMemoryRulesStore(),
    queue: new InMemoryConfirmationQueue(),
    structured: new InMemoryStructuredStore(),
    registry: new ToolRegistry(),
  };
}

/** Parse an SSE body into ordered { event, data } frames (mirrors the web client). */
function parseSse(raw: string): Array<{ event: string; data: unknown }> {
  return raw
    .split('\n\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((frame) => {
      const event = /event: (.*)/.exec(frame)?.[1] ?? '';
      const data = /data: (.*)/.exec(frame)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe('SSE chat stream', () => {
  it('streams start, live tokens, cumulative activity, and a terminal done', async () => {
    const server = new ApiServer({ deps: deps(), port: 0, logger: silentLogger });
    await server.start();
    const base = `http://localhost:${server.address()}`;
    try {
      const res = await fetch(`${base}/api/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

      const frames = parseSse(await res.text());
      const events = frames.map((f) => f.event);

      // The browser concatenates token frames into the assistant bubble.
      const tokens = frames.filter((f) => f.event === 'token').map((f) => (f.data as { token: string }).token);
      assert.deepEqual(tokens, ['Hello ', 'world']);

      // start precedes tokens; done is last.
      assert.equal(events[0], 'start');
      assert.equal(events.at(-1), 'done');

      // activity frames are cumulative — the last one carries every audit event.
      const activityFrames = frames.filter((f) => f.event === 'activity');
      assert.ok(activityFrames.length >= 1);
      const lastActivity = (activityFrames.at(-1)!.data as { events: Array<{ type: string }> }).events;
      assert.deepEqual(lastActivity.map((e) => e.type), ['run_started', 'tool_executed']);

      const done = frames.find((f) => f.event === 'done')!.data as { stopReason: string; toolCalls: unknown[] };
      assert.equal(done.stopReason, 'completed');
      assert.deepEqual(done.toolCalls, [{ name: 'calculate', ok: true }]);
    } finally {
      await server.stop();
    }
  });

  it('emits an error frame for a request with no text', async () => {
    const server = new ApiServer({ deps: deps(), port: 0, logger: silentLogger });
    await server.start();
    const base = `http://localhost:${server.address()}`;
    try {
      const res = await fetch(`${base}/api/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      });
      const frames = parseSse(await res.text());
      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.event, 'error');
      assert.match((frames[0]!.data as { error: string }).error, /text is required/);
    } finally {
      await server.stop();
    }
  });
});
