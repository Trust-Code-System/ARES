/**
 * Phase 4 — Autonomy control plane. All deterministic and infra-free: the kill
 * switch and activity feed use their in-memory impls and the runner drives a fake
 * agent that respects the AbortSignal. No network, no DB, no timers left running.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InMemoryActivityFeed,
  InMemoryKillSwitch,
} from '../src/autonomy/store.js';
import { AutonomousRunner, type AgentLike } from '../src/autonomy/runner.js';
import {
  InMemoryScheduler,
  nextRun,
  type TimerDriver,
} from '../src/autonomy/scheduler.js';
import { agentJob } from '../src/autonomy/jobs.js';
import {
  morningBriefingJob,
  inboxScanJob,
  MORNING_BRIEFING_CRON,
  INBOX_SCAN_CRON,
} from '../src/autonomy/briefingJobs.js';
import { WebhookHandler } from '../src/autonomy/webhooks.js';
import type { AgentInput, AgentRunResult, Logger } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

/** A fake agent that completes immediately with a fixed result. */
function fixedAgent(result: Partial<AgentRunResult> = {}): AgentLike {
  return {
    async run(): Promise<AgentRunResult> {
      return {
        runId: 'run-1',
        finalText: 'done',
        stopReason: 'completed',
        iterations: 1,
        toolCalls: [],
        ...result,
      };
    },
  };
}

/**
 * A fake agent that blocks until the AbortSignal fires, then resolves as the
 * orchestrator would on abort. Lets us prove the kill switch stops an in-flight run.
 */
function blockingAgent(): { agent: AgentLike; started: Promise<void> } {
  let onStart: () => void;
  const started = new Promise<void>((res) => {
    onStart = res;
  });
  const agent: AgentLike = {
    run(_input: AgentInput, signal?: AbortSignal): Promise<AgentRunResult> {
      onStart();
      return new Promise<AgentRunResult>((resolve) => {
        const finish = () =>
          resolve({
            runId: 'run-abort',
            finalText: '',
            stopReason: 'aborted',
            iterations: 1,
            toolCalls: [],
          });
        if (signal?.aborted) return finish();
        signal?.addEventListener('abort', finish, { once: true });
      });
    },
  };
  return { agent, started };
}

/**
 * A controllable timer driver: nothing fires until the test advances the clock,
 * so the scheduler's firing loop is deterministic and never waits real time.
 */
class FakeTimers implements TimerDriver {
  private current: number;
  private seq = 0;
  private readonly scheduled = new Map<number, { fn: () => void; at: number }>();

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.scheduled.set(id, { fn, at: this.current + ms });
    return id;
  }

  clear(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  pending(): number {
    return this.scheduled.size;
  }

  /** Jump to the earliest pending timer, fire it, and flush microtasks. */
  async fireNext(): Promise<void> {
    const next = [...this.scheduled.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return;
    this.current = next[1].at;
    this.scheduled.delete(next[0]);
    next[1].fn();
    await new Promise((r) => setImmediate(r));
  }
}

describe('InMemoryKillSwitch', () => {
  it('engages, disengages, and reports state', async () => {
    const ks = new InMemoryKillSwitch();
    assert.equal((await ks.state()).engaged, false);

    const engaged = await ks.engage('too risky', 'cli');
    assert.equal(engaged.engaged, true);
    assert.equal(engaged.reason, 'too risky');
    assert.equal(engaged.changedBy, 'cli');

    const running = await ks.disengage('cli');
    assert.equal(running.engaged, false);
    assert.equal(running.reason, null);
  });

  it('fires onEngage only on a false→true transition, and respects unsubscribe', async () => {
    const ks = new InMemoryKillSwitch();
    let fired = 0;
    const off = ks.onEngage(() => fired++);

    await ks.engage('a', 'cli');
    await ks.engage('b', 'cli'); // already engaged → no second fire
    assert.equal(fired, 1);

    off();
    await ks.disengage('cli');
    await ks.engage('c', 'cli'); // unsubscribed → not counted
    assert.equal(fired, 1);
  });
});

describe('InMemoryActivityFeed', () => {
  it('opens a running record and closes it with a terminal status + runId', async () => {
    const feed = new InMemoryActivityFeed();
    const rec = await feed.start({ trigger: 'manual' });
    assert.equal(rec.status, 'running');
    assert.equal(rec.finishedAt, null);

    const done = await feed.finish(rec.id, { status: 'completed', detail: 'ok', runId: 'run-9' });
    assert.equal(done?.status, 'completed');
    assert.equal(done?.runId, 'run-9');
    assert.notEqual(done?.finishedAt, null);
  });

  it('returns recent records newest-first, capped at the limit', async () => {
    const feed = new InMemoryActivityFeed();
    for (let i = 0; i < 3; i++) await feed.start({ trigger: `t${i}` });
    const recent = await feed.recent(2);
    assert.equal(recent.length, 2);
    // startedAt is monotonic non-decreasing; the cap keeps the freshest two.
    assert.ok(recent[0]!.startedAt >= recent[1]!.startedAt);
  });
});

describe('AutonomousRunner', () => {
  const build = (agent: AgentLike, ks = new InMemoryKillSwitch(), pollIntervalMs = 0) => {
    const activityFeed = new InMemoryActivityFeed();
    const runner = new AutonomousRunner({ agent, killSwitch: ks, activityFeed, logger, pollIntervalMs });
    return { runner, ks, activityFeed };
  };

  const task = { trigger: 'manual', input: { text: 'hi', source: 'event' as const } };

  it('runs the task and records a completed activity', async () => {
    const { runner, activityFeed } = build(fixedAgent());
    const result = await runner.run(task);
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, 'run-1');

    const [rec] = await activityFeed.recent();
    assert.equal(rec?.status, 'completed');
    assert.equal(rec?.runId, 'run-1');
  });

  it('skips the run (without invoking the agent) when the kill switch is engaged', async () => {
    const ks = new InMemoryKillSwitch();
    await ks.engage('paused', 'cli');
    let invoked = false;
    const agent: AgentLike = {
      async run() {
        invoked = true;
        return fixedAgent().run({ text: '', source: 'event' });
      },
    };
    const { runner, activityFeed } = build(agent, ks);

    const result = await runner.run(task);
    assert.equal(result.status, 'skipped');
    assert.equal(invoked, false);
    const [rec] = await activityFeed.recent();
    assert.equal(rec?.status, 'skipped');
    assert.match(rec!.detail, /kill switch engaged: paused/);
  });

  it('aborts an in-flight run when the kill switch is engaged mid-run', async () => {
    const { agent, started } = blockingAgent();
    const ks = new InMemoryKillSwitch();
    const { runner, activityFeed } = build(agent, ks);

    const runPromise = runner.run(task);
    await started; // ensure the agent is actually mid-run before we trip the switch
    await ks.engage('emergency stop', 'cli');

    const result = await runPromise;
    assert.equal(result.status, 'aborted');
    const [rec] = await activityFeed.recent();
    assert.equal(rec?.status, 'aborted');
  });

  it('records a failed activity when the agent throws', async () => {
    const agent: AgentLike = {
      async run() {
        throw new Error('boom');
      },
    };
    const { runner, activityFeed } = build(agent);
    const result = await runner.run(task);
    assert.equal(result.status, 'failed');
    const [rec] = await activityFeed.recent();
    assert.equal(rec?.status, 'failed');
    assert.match(rec!.detail, /boom/);
  });

  it('maps agent stopReason onto activity status (error → failed)', async () => {
    const { runner } = build(fixedAgent({ stopReason: 'error' }));
    const result = await runner.run(task);
    assert.equal(result.status, 'failed');
  });
});

describe('nextRun', () => {
  it('computes the next occurrence of a cron expression', () => {
    const from = new Date('2026-06-14T12:00:00');
    const next = nextRun('0 6 * * *', from); // 06:00 daily, local time
    assert.equal(next > from, true);
    assert.equal(next.getHours(), 6);
    assert.equal(next.getMinutes(), 0);
    // 12:00 is past today's 06:00, so the next fire is tomorrow.
    assert.equal(next.getDate(), 15);
  });

  it('throws on an invalid cron expression', () => {
    assert.throws(() => nextRun('not a cron'));
  });
});

describe('InMemoryScheduler', () => {
  it('rejects an invalid cron and a duplicate job name at register time', () => {
    const sched = new InMemoryScheduler(logger);
    sched.register({ name: 'a', cron: '0 6 * * *', handler: async () => {} });
    assert.throws(() => sched.register({ name: 'a', cron: '0 7 * * *', handler: async () => {} }), /already registered/);
    assert.throws(() => sched.register({ name: 'b', cron: 'nope', handler: async () => {} }));
  });

  it('fires a due job, then re-arms it for the following occurrence', async () => {
    const timers = new FakeTimers(Date.parse('2026-06-14T05:00:00'));
    const sched = new InMemoryScheduler(logger, timers);
    let fired = 0;
    sched.register({ name: 'job', cron: '0 6 * * *', handler: async () => { fired++; } });

    await sched.start();
    assert.equal(timers.pending(), 1); // armed for the next 06:00

    await timers.fireNext();
    assert.equal(fired, 1);
    assert.equal(timers.pending(), 1); // re-armed for the day after

    await sched.stop();
    assert.equal(timers.pending(), 0); // stop clears outstanding timers
  });

  it('keeps the schedule alive when a job handler throws', async () => {
    const timers = new FakeTimers(Date.parse('2026-06-14T05:00:00'));
    const sched = new InMemoryScheduler(logger, timers);
    sched.register({ name: 'flaky', cron: '0 6 * * *', handler: async () => { throw new Error('boom'); } });
    await sched.start();
    await timers.fireNext(); // throws inside, but is guarded
    assert.equal(timers.pending(), 1); // still re-armed
    await sched.stop();
  });

  it('trigger() runs a registered job immediately and rejects unknown names', async () => {
    const sched = new InMemoryScheduler(logger);
    let ran = false;
    sched.register({ name: 'now', cron: '0 6 * * *', handler: async () => { ran = true; } });
    await sched.trigger('now');
    assert.equal(ran, true);
    await assert.rejects(sched.trigger('missing'), /No scheduled job/);
  });

  it('a scheduled agent job routes through the runner and honors the kill switch', async () => {
    const ks = new InMemoryKillSwitch();
    await ks.engage('paused', 'test');
    const activityFeed = new InMemoryActivityFeed();
    const runner = new AutonomousRunner({ agent: fixedAgent(), killSwitch: ks, activityFeed, logger, pollIntervalMs: 0 });

    const sched = new InMemoryScheduler(logger);
    sched.register(
      agentJob({ name: 'briefing', cron: '0 6 * * *', runner, input: { text: 'go', source: 'event' } }),
    );

    await sched.trigger('briefing');
    const [rec] = await activityFeed.recent();
    assert.equal(rec?.trigger, 'schedule:briefing');
    assert.equal(rec?.status, 'skipped'); // kill switch engaged → the fire is skipped, not silently dropped
  });
});

describe('briefing jobs', () => {
  it('define valid crons (06:00 daily briefing, hourly inbox scan)', () => {
    assert.equal(MORNING_BRIEFING_CRON, '0 6 * * *');
    assert.equal(INBOX_SCAN_CRON, '0 * * * *');
    // Both must parse; nextRun throws otherwise.
    const six = nextRun(MORNING_BRIEFING_CRON, new Date('2026-06-14T12:00:00'));
    assert.equal(six.getHours(), 6);
    assert.equal(nextRun(INBOX_SCAN_CRON, new Date('2026-06-14T12:30:00')).getMinutes(), 0);
  });

  it('run through the autonomous runner with the right trigger names', async () => {
    const ks = new InMemoryKillSwitch();
    const activityFeed = new InMemoryActivityFeed();
    const runner = new AutonomousRunner({ agent: fixedAgent(), killSwitch: ks, activityFeed, logger, pollIntervalMs: 0 });

    const briefing = morningBriefingJob(runner);
    const inbox = inboxScanJob(runner);
    assert.equal(briefing.name, 'morning-briefing');
    assert.equal(inbox.name, 'inbox-scan');

    await briefing.handler();
    await inbox.handler();
    const recent = await activityFeed.recent();
    const triggers = recent.map((r) => r.trigger).sort();
    assert.deepEqual(triggers, ['schedule:inbox-scan', 'schedule:morning-briefing']);
    assert.ok(recent.every((r) => r.status === 'completed'));
  });
});

describe('WebhookHandler', () => {
  const SECRET = 'top-secret-token';
  const build = () => {
    const ks = new InMemoryKillSwitch();
    const activityFeed = new InMemoryActivityFeed();
    const runner = new AutonomousRunner({ agent: fixedAgent(), killSwitch: ks, activityFeed, logger, pollIntervalMs: 0 });
    const handler = new WebhookHandler({ runner, secret: SECRET, logger });
    return { handler, activityFeed };
  };

  it('rejects a wrong/missing token and never dispatches', () => {
    const { handler } = build();
    const noToken = handler.handle({ method: 'POST', path: '/webhook/github', body: '{}' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.dispatched, undefined);

    const badToken = handler.handle({ method: 'POST', path: '/webhook/github', token: 'wrong', body: '{}' });
    assert.equal(badToken.status, 401);
  });

  it('405s non-POST and 404s a non-webhook path', () => {
    const { handler } = build();
    assert.equal(handler.handle({ method: 'GET', path: '/webhook/x', token: SECRET, body: '' }).status, 405);
    assert.equal(handler.handle({ method: 'POST', path: '/nope', token: SECRET, body: '' }).status, 404);
  });

  it('400s an invalid JSON body', () => {
    const { handler } = build();
    const res = handler.handle({ method: 'POST', path: '/webhook/github', token: SECRET, body: '{not json' });
    assert.equal(res.status, 400);
  });

  it('accepts a valid request and dispatches a webhook-triggered run', async () => {
    const { handler, activityFeed } = build();
    const res = handler.handle({
      method: 'POST',
      path: '/webhook/github',
      token: SECRET,
      body: JSON.stringify({ prompt: 'a PR was merged; summarize it' }),
    });
    assert.equal(res.status, 202);
    assert.match(res.body, /webhook:github/);
    assert.ok(res.dispatched);

    const result = await res.dispatched!;
    assert.equal(result.status, 'completed');
    const [rec] = await activityFeed.recent();
    assert.equal(rec?.trigger, 'webhook:github');
  });
});
