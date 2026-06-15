/**
 * Durable memory ingestion queue (BullMQ) — exercised with fake Queue/Worker, so
 * the enqueue payload, drain-to-empty loop, worker dispatch, and error handling
 * are covered without a live Redis. The real BullMQ wiring lives in
 * createBullMqMemoryQueue and is out of the unit suite's scope.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BullMqMemoryQueue,
  type BullMqMemoryDeps,
  type IngestQueue,
} from '../src/memory/bullmqQueue.js';
import type { Logger, MemoryTurn, MemoryWriter } from '../src/types.js';

const turn: MemoryTurn = { runId: 'r1', source: 'user', userText: 'hi', assistantText: 'hello' };

function captureLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const logger: Logger = {
    log() {}, debug() {}, info() {}, warn() {},
    error: (msg) => { errors.push(msg); },
  };
  return { logger, errors };
}

/** Fake queue with a controllable outstanding-count. */
class FakeQueue implements IngestQueue {
  added: { name: string; data: MemoryTurn }[] = [];
  closed = false;
  outstanding = 0;
  async add(name: string, data: MemoryTurn): Promise<unknown> {
    this.added.push({ name, data });
    this.outstanding++;
    return {};
  }
  async getJobCounts(): Promise<Record<string, number>> {
    return { waiting: this.outstanding };
  }
  async close(): Promise<void> { this.closed = true; }
}

function build() {
  const queue = new FakeQueue();
  let processor: ((t: MemoryTurn) => Promise<void>) | undefined;
  let workerClosed = false;
  const deps: BullMqMemoryDeps = {
    queue,
    createWorker: (p) => { processor = p; return { async close() { workerClosed = true; } }; },
  };
  return { queue, deps, getProcessor: () => processor, wasWorkerClosed: () => workerClosed };
}

describe('BullMqMemoryQueue', () => {
  it('enqueues the exchange as a job and returns fast', async () => {
    const { queue, deps } = build();
    const q = new BullMqMemoryQueue(deps, captureLogger().logger);
    await q.enqueue(turn);
    assert.equal(queue.added.length, 1);
    assert.equal(queue.added[0]!.name, 'ingest');
    assert.deepEqual(queue.added[0]!.data, turn);
  });

  it('drain returns immediately when no worker is attached (another process handles it)', async () => {
    const { queue, deps } = build();
    const q = new BullMqMemoryQueue(deps, captureLogger().logger);
    queue.outstanding = 5; // backlog exists, but we hold no worker
    await q.drain(); // must not hang or wait
    assert.equal(queue.outstanding, 5);
  });

  it('worker drains the backlog; drain waits until empty', async () => {
    const { queue, deps, getProcessor } = build();
    const ingested: string[] = [];
    const ingestor: MemoryWriter = { async ingest(t) { ingested.push(t.runId); queue.outstanding--; } };
    const q = new BullMqMemoryQueue(deps, captureLogger().logger);
    q.startWorker(ingestor);

    await q.enqueue(turn);
    await q.enqueue({ ...turn, runId: 'r2' });
    assert.equal(queue.outstanding, 2);

    // Simulate the worker processing each job (BullMQ would call the processor).
    await getProcessor()!(turn);
    await getProcessor()!({ ...turn, runId: 'r2' });

    await q.drain();
    assert.deepEqual(ingested, ['r1', 'r2']);
    assert.equal(queue.outstanding, 0);
  });

  it('logs and rethrows when the ingestor fails so BullMQ marks the job failed', async () => {
    const { deps, getProcessor } = build();
    const { logger, errors } = captureLogger();
    const ingestor: MemoryWriter = { async ingest() { throw new Error('embedding down'); } };
    const q = new BullMqMemoryQueue(deps, logger);
    q.startWorker(ingestor);

    await assert.rejects(() => getProcessor()!(turn), /embedding down/);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /background memory ingest failed/);
  });

  it('close releases the worker and the queue', async () => {
    const { queue, deps, wasWorkerClosed } = build();
    const q = new BullMqMemoryQueue(deps, captureLogger().logger);
    q.startWorker({ async ingest() {} });
    await q.close();
    assert.equal(queue.closed, true);
    assert.equal(wasWorkerClosed(), true);
  });
});
