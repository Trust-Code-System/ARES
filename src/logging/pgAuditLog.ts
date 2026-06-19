/**
 * Durable audit log (Postgres).
 *
 * Replaces {@link InMemoryAuditLog} when a database is configured. The
 * orchestrator's {@link AuditLog} contract is synchronous (`record` returns
 * void) because the loop must never block on the audit trail. So writes are
 * enqueued and flushed by a background drain; `record` stays non-blocking.
 *
 * The DB table is append-only (an UPDATE/DELETE trigger enforces immutability),
 * which is the real source of truth. We also keep a small in-process mirror of
 * recent events so `forRun` works synchronously for the live activity feed; for
 * durable historical reads, use the async {@link PostgresAuditLog.queryRun}.
 */

import type { AuditEvent, AuditLog, Logger } from '../types.js';
import type { Db } from '../db/client.js';
import { redactSensitiveData } from '../security/redactor.js';

export class PostgresAuditLog implements AuditLog {
  private readonly queue: AuditEvent[] = [];
  private readonly mirror: AuditEvent[] = [];
  private draining = false;
  /** Resolves when the queue is empty — lets callers await a clean shutdown. */
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: () => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly logger?: Logger,
    /** Cap on the in-process mirror so it can't grow unbounded. */
    private readonly mirrorLimit = 5000,
  ) {}

  record(event: AuditEvent): void {
    const stored = redactSensitiveData(structuredClone(event));
    this.mirror.push(stored);
    if (this.mirror.length > this.mirrorLimit) this.mirror.shift();
    this.queue.push(stored);
    void this.drain();
  }

  forRun(runId: string): AuditEvent[] {
    return structuredClone(this.mirror.filter((e) => e.runId === runId));
  }

  /** Durable read straight from the table. */
  async queryRun(runId: string): Promise<AuditEvent[]> {
    const res = await this.db.query<{
      run_id: string;
      ts: string;
      type: AuditEvent['type'];
      detail: Record<string, unknown>;
    }>(
      `select run_id, ts, type, detail from audit_log where run_id = $1 order by id`,
      [runId],
    );
    return res.rows.map((r) => ({
      runId: r.run_id,
      ts: new Date(r.ts).toISOString(),
      type: r.type,
          detail: redactSensitiveData(r.detail ?? {}),
    }));
  }

  /** Await until every queued event has been written (use before shutdown). */
  async flush(): Promise<void> {
    await this.idle;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.idle = new Promise((resolve) => (this.resolveIdle = resolve));

    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      try {
        await this.db.query(
          `insert into audit_log (run_id, ts, type, detail) values ($1, $2, $3, $4)`,
          [event.runId, event.ts, event.type, JSON.stringify(event.detail)],
        );
      } catch (err) {
        // Losing an audit row must not crash the agent; surface it loudly.
        this.logger?.error('audit write failed', {
          runId: event.runId,
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.draining = false;
    this.resolveIdle();
  }
}
