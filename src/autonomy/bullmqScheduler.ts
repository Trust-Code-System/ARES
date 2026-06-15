/**
 * The durable scheduler — BullMQ on Redis (the locked Phase-4 stack).
 *
 * Used when REDIS_URL is set. Each registered job becomes a BullMQ *job scheduler*
 * (a cron-recurring producer); a single {@link Worker} drains the queue and
 * dispatches each job to its registered handler by name. Because scheduler state
 * lives in Redis, schedules survive process restarts and can be processed by more
 * than one worker — the reason this, not the in-memory scheduler, is the
 * production path.
 *
 * Cron semantics match {@link InMemoryScheduler}: BullMQ also uses cron-parser, so
 * `0 6 * * *` fires at 06:00 local time in both backends.
 *
 * We hand BullMQ connection *options* (parsed from REDIS_URL) rather than an
 * ioredis instance, so it constructs and owns its own client — avoiding a
 * dependency on a second, type-incompatible copy of ioredis. Not exercised by the
 * unit suite (that needs a live Redis); it is kept thin and type-checked against
 * the BullMQ API, with all behaviour-under-test living in the in-memory backend
 * and the shared {@link nextRun} helper.
 */

import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from '../types.js';
import { nextRun, type Scheduler, type ScheduledJob } from './scheduler.js';

const QUEUE_NAME = 'ares-autonomy';

export class BullMqScheduler implements Scheduler {
  private readonly registered = new Map<string, ScheduledJob>();
  private readonly connection: ConnectionOptions;
  private queue?: Queue;
  private worker?: Worker;
  private started = false;

  constructor(redisUrl: string, private readonly logger: Logger) {
    this.connection = connectionFromUrl(redisUrl);
  }

  register(job: ScheduledJob): void {
    if (this.registered.has(job.name)) {
      throw new Error(`A scheduled job named "${job.name}" is already registered.`);
    }
    nextRun(job.cron); // validate the cron expression up front
    this.registered.set(job.name, job);
    // Parity with InMemoryScheduler: registering after start() still takes effect.
    // upsert is async and register is sync, so fire-and-forget with error logging.
    if (this.started && this.queue) {
      void this.upsert(this.queue, job).catch((err) =>
        this.logger.error('failed to schedule job registered after start', {
          job: job.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  jobs(): ScheduledJob[] {
    return [...this.registered.values()];
  }

  /** Dispatch a due job to its registered handler. Exposed for testing the routing. */
  async process(name: string): Promise<void> {
    const def = this.registered.get(name);
    if (!def) {
      this.logger.warn('no handler for scheduled job; skipping', { job: name });
      return;
    }
    await def.handler();
  }

  async start(): Promise<void> {
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => this.process(job.name),
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error('scheduled job failed', { job: job?.name, error: err.message });
    });

    // Idempotent: re-running upsert with the same scheduler id just updates the cron.
    for (const job of this.registered.values()) {
      await this.upsert(this.queue, job);
    }
    this.started = true;
    this.logger.info('scheduler started (bullmq)', { jobs: this.registered.size, queue: QUEUE_NAME });
  }

  private async upsert(queue: Queue, job: ScheduledJob): Promise<void> {
    await queue.upsertJobScheduler(job.name, { pattern: job.cron }, { name: job.name });
  }

  async trigger(name: string): Promise<void> {
    const def = this.registered.get(name);
    if (!def) throw new Error(`No scheduled job named "${name}".`);
    if (!this.queue) throw new Error('Scheduler not started; call start() before trigger().');
    // A one-off job (no repeat) so the running worker picks it up immediately.
    await this.queue.add(name, {}, { jobId: `${name}:manual:${Date.now()}` });
    this.logger.info('scheduled job triggered manually', { job: name });
  }

  async stop(): Promise<void> {
    // Closing the worker and queue tears down the ioredis connections BullMQ owns.
    await this.worker?.close();
    await this.queue?.close();
    this.started = false;
    this.logger.info('scheduler stopped (bullmq)');
  }
}

/** Parse a redis(s):// URL into BullMQ/ioredis connection options. */
export function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  const opts: Record<string, unknown> = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    // Required by BullMQ for its blocking commands.
    maxRetriesPerRequest: null,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) opts.db = Number(db);
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts as ConnectionOptions;
}
