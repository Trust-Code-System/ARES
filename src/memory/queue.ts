/**
 * Memory ingestion off the hot path.
 *
 * Phase 2 ran {@link MemoryIngestor} inline at the end of every agent run — the
 * user's turn didn't return until the exchange had been embedded and facts
 * extracted (an extra model call + embedding round trip). Phase 4 decouples that:
 * the orchestrator now hands the finished exchange to a {@link QueuedMemoryWriter},
 * which only *enqueues* it and returns immediately; a background worker drains the
 * queue and does the slow work.
 *
 * {@link InMemoryMemoryQueue} is the zero-infra worker: an in-process promise
 * chain that processes turns serially after the responding turn has returned.
 * Ingestion failures are logged, never thrown — a memory hiccup must not surface
 * as a turn failure. One-shot CLIs call {@link MemoryQueue.drain} before exiting so
 * the process doesn't quit mid-ingest. (A durable Redis/BullMQ-backed queue with a
 * separate worker process is the natural next step; the interface is ready for it.)
 */

import type { Logger, MemoryTurn, MemoryWriter } from '../types.js';

export interface MemoryQueue {
  /** Hand off a finished exchange for background ingestion. Returns fast. */
  enqueue(turn: MemoryTurn): Promise<void>;
  /** Resolve once all enqueued work so far has been processed. */
  drain(): Promise<void>;
}

/** In-process queue: serial, fire-and-forget, drained on demand. */
export class InMemoryMemoryQueue implements MemoryQueue {
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;

  constructor(
    private readonly ingestor: MemoryWriter,
    private readonly logger: Logger,
  ) {}

  async enqueue(turn: MemoryTurn): Promise<void> {
    this.depth++;
    // Append to the chain but DON'T await it — this is what takes ingestion off
    // the caller's hot path. Work runs after the current turn has returned.
    this.chain = this.chain.then(() => this.process(turn));
  }

  private async process(turn: MemoryTurn): Promise<void> {
    try {
      await this.ingestor.ingest(turn);
    } catch (err) {
      this.logger.error('background memory ingest failed', {
        runId: turn.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.depth--;
    }
  }

  async drain(): Promise<void> {
    // The chain may grow while we await; loop until it's genuinely settled.
    let previous: Promise<void> | undefined;
    while (previous !== this.chain) {
      previous = this.chain;
      await previous;
    }
  }

  /** Number of turns enqueued but not yet processed (for diagnostics/tests). */
  pending(): number {
    return this.depth;
  }
}

/**
 * A {@link MemoryWriter} that just enqueues. This is what the orchestrator holds,
 * so its `ingest` call is cheap and the turn returns without waiting on embeddings.
 */
export class QueuedMemoryWriter implements MemoryWriter {
  constructor(private readonly queue: MemoryQueue) {}

  async ingest(turn: MemoryTurn): Promise<void> {
    await this.queue.enqueue(turn);
  }
}
