/**
 * Durable memory ingestion queue — BullMQ on Redis.
 *
 * The {@link InMemoryMemoryQueue} (queue.ts) drains in-process, so anything still
 * queued when the process dies is lost. This backs the same {@link MemoryQueue}
 * contract with a Redis queue, so a finished exchange that's been enqueued
 * survives a crash/restart: a worker (in this process or a dedicated one) picks it
 * up afterwards. Used when `REDIS_URL` is set; the in-memory queue otherwise.
 *
 * The BullMQ `Queue`/`Worker` are reached through the small {@link BullMqMemoryDeps}
 * surface so the logic here (enqueue payload, drain-to-empty, worker dispatch +
 * error handling) is unit-tested with fakes — no live Redis in the suite. The real
 * wiring lives in {@link createBullMqMemoryQueue}.
 */

import { Queue, Worker, type Job } from 'bullmq';
import type { Logger, MemoryTurn, MemoryWriter } from '../types.js';
import type { MemoryQueue } from './queue.js';
import { connectionFromUrl } from '../autonomy/bullmqScheduler.js';

const QUEUE_NAME = 'ares-memory';
const JOB_NAME = 'ingest';
/** Job states that still need processing (failed/completed don't block a drain). */
const OUTSTANDING_STATES = ['waiting', 'active', 'delayed', 'paused', 'prioritized'] as const;

/** Minimal BullMQ Queue surface this module needs (injectable for tests). */
export interface IngestQueue {
  add(name: string, data: MemoryTurn, opts?: unknown): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/** Minimal BullMQ Worker surface (injectable for tests). */
export interface IngestWorker {
  close(): Promise<void>;
}

export interface BullMqMemoryDeps {
  queue: IngestQueue;
  /** Build a worker that runs `processor` for each job. Called by startWorker. */
  createWorker(processor: (turn: MemoryTurn) => Promise<void>): IngestWorker;
}

export class BullMqMemoryQueue implements MemoryQueue {
  private worker?: IngestWorker;

  constructor(private readonly deps: BullMqMemoryDeps, private readonly logger: Logger) {}

  async enqueue(turn: MemoryTurn): Promise<void> {
    // Persist the job to Redis and return — the slow ingest happens in the worker.
    // Keep completed jobs out of Redis; retain a bounded tail of failures to inspect.
    await this.deps.queue.add(JOB_NAME, turn, { removeOnComplete: true, removeOnFail: 100 });
  }

  /**
   * Attach an in-process worker that drains the queue into the ingestor. Optional:
   * a deployment can instead run a dedicated worker process and never call this.
   */
  startWorker(ingestor: MemoryWriter): void {
    this.worker = this.deps.createWorker(async (turn) => {
      try {
        await ingestor.ingest(turn);
      } catch (err) {
        // Log and rethrow so BullMQ records the job as failed (and can retry per
        // its attempts policy) rather than silently marking it complete.
        this.logger.error('background memory ingest failed', {
          runId: turn.runId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }

  /**
   * Wait until the queue is empty. Only meaningful when a worker is attached in
   * this process; otherwise returns immediately, since durability means another
   * worker will handle the backlog (a one-shot CLI shouldn't block on it).
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    if (!this.worker) return;
    const started = Date.now();
    for (;;) {
      const counts = await this.deps.queue.getJobCounts(...OUTSTANDING_STATES);
      const outstanding = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
      if (outstanding === 0) return;
      if (Date.now() - started > timeoutMs) {
        this.logger.warn('memory queue drain timed out', { outstanding });
        return;
      }
      await delay(50);
    }
  }

  /** Release the worker + queue connections (shutdown). */
  async close(): Promise<void> {
    await this.worker?.close();
    await this.deps.queue.close();
  }
}

/** Wire a {@link BullMqMemoryQueue} to a real Redis via BullMQ. */
export function createBullMqMemoryQueue(redisUrl: string, logger: Logger): BullMqMemoryQueue {
  const connection = connectionFromUrl(redisUrl);
  const queue = new Queue(QUEUE_NAME, { connection }) as unknown as IngestQueue;
  const deps: BullMqMemoryDeps = {
    queue,
    createWorker: (processor) =>
      new Worker(QUEUE_NAME, async (job: Job) => processor(job.data as MemoryTurn), {
        connection,
      }) as unknown as IngestWorker,
  };
  return new BullMqMemoryQueue(deps, logger);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
