/**
 * The scheduler — how ARES wakes itself up on a clock.
 *
 * A {@link Scheduler} holds named, cron-recurring {@link ScheduledJob}s and fires
 * their handlers when due. The handlers are usually {@link AutonomousRunner} tasks
 * (see jobs.ts), so each firing inherits the Phase-4 invariants for free: the kill
 * switch can skip/abort it, and the activity feed records it.
 *
 * Two implementations, the usual ARES split:
 *   - {@link InMemoryScheduler} — zero-infra, the tested fallback. Jobs run only
 *     while this process is alive; nothing persists. Timer functions are injectable
 *     so the firing loop is deterministically testable without real time.
 *   - {@link BullMqScheduler} (bullmqScheduler.ts) — the durable Redis-backed path
 *     used when REDIS_URL is set; survives restarts and can run multiple workers.
 *
 * Cron strings are parsed with cron-parser in LOCAL time (so `0 6 * * *` means
 * 06:00 in the host's timezone — what you want for a morning briefing).
 */

import { CronExpressionParser } from 'cron-parser';
import type { Logger } from '../types.js';

/** A named, cron-recurring unit of autonomous work. */
export interface ScheduledJob {
  /** Unique across the scheduler. Also the activity-feed trigger suffix. */
  name: string;
  /** Standard 5-field cron expression, interpreted in local time. */
  cron: string;
  /** Invoked on each firing. Must not throw for the schedule to survive — but the scheduler guards it anyway. */
  handler: () => Promise<void>;
}

export interface Scheduler {
  /** Add a job. Throws on a duplicate name or an invalid cron. Call before {@link start}. */
  register(job: ScheduledJob): void;
  /** Begin firing registered jobs on their schedules. */
  start(): Promise<void>;
  /** Stop all firing and release resources. */
  stop(): Promise<void>;
  /** Run a registered job once, immediately, out of schedule (manual/test). */
  trigger(name: string): Promise<void>;
  /** The registered jobs, for introspection (CLI/dashboard). */
  jobs(): ScheduledJob[];
}

/**
 * Next fire time for a cron expression at or after `from`. Pure; throws on an
 * invalid expression (which is how {@link Scheduler.register} validates cron).
 */
export function nextRun(cron: string, from: Date = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate();
}

/** Injectable timing surface so the firing loop can be driven by a fake clock in tests. */
export interface TimerDriver {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

/** Real timers; unref'd so a pending fire never keeps the process alive on its own. */
const realTimers: TimerDriver = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class InMemoryScheduler implements Scheduler {
  private readonly registered = new Map<string, ScheduledJob>();
  private readonly handles = new Map<string, unknown>();
  private running = false;

  constructor(
    private readonly logger: Logger,
    private readonly timers: TimerDriver = realTimers,
  ) {}

  register(job: ScheduledJob): void {
    if (this.registered.has(job.name)) {
      throw new Error(`A scheduled job named "${job.name}" is already registered.`);
    }
    // Validate the cron now so a typo fails loudly at wiring time, not at 6am.
    nextRun(job.cron, new Date(this.timers.now()));
    this.registered.set(job.name, job);
    // Registering after start() should still take effect.
    if (this.running) this.schedule(job);
  }

  jobs(): ScheduledJob[] {
    return [...this.registered.values()];
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const job of this.registered.values()) this.schedule(job);
    this.logger.info('scheduler started (in-memory)', { jobs: this.registered.size });
  }

  async trigger(name: string): Promise<void> {
    const job = this.registered.get(name);
    if (!job) throw new Error(`No scheduled job named "${name}".`);
    this.logger.info('scheduled job triggered manually', { job: name });
    await job.handler();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const handle of this.handles.values()) this.timers.clear(handle);
    this.handles.clear();
    this.logger.info('scheduler stopped (in-memory)');
  }

  /** Arm a single timer for this job's next occurrence. */
  private schedule(job: ScheduledJob): void {
    const now = this.timers.now();
    // setTimeout caps at ~24.8 days; daily/hourly crons are well within range.
    const delay = Math.max(0, nextRun(job.cron, new Date(now)).getTime() - now);
    const handle = this.timers.set(() => {
      void this.fire(job);
    }, delay);
    this.handles.set(job.name, handle);
  }

  /** Run a job's handler (guarded), then arm the next occurrence. */
  private async fire(job: ScheduledJob): Promise<void> {
    if (!this.running) return;
    try {
      await job.handler();
    } catch (err) {
      this.logger.error('scheduled job threw', {
        job: job.name,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Re-arm only if we're still running and weren't replaced/stopped meanwhile.
      if (this.running) this.schedule(job);
    }
  }
}
