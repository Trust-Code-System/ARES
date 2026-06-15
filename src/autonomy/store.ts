/**
 * Autonomy control plane: the kill switch + the activity feed.
 *
 * Contracts plus in-memory implementations (the no-DB fallback and the test
 * doubles). Postgres implementations live in pgStore.ts. This mirrors the shape
 * of safety/store.ts so the "with DB / without DB" story is identical across the
 * codebase.
 *
 * The kill switch is the Phase-4 promise that autonomy never runs away: a single
 * durable flag that, when engaged, both blocks new autonomous runs and aborts
 * in-flight ones. The activity feed is the user-facing log of what autonomy did.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/** The global pause state for all autonomous activity. */
export interface KillSwitchState {
  engaged: boolean;
  /** Why it was engaged; null while running. */
  reason: string | null;
  /** ISO timestamp of the last toggle. */
  changedAt: string;
  /** Who toggled it (e.g. 'cli', 'ui', 'system'); null if never toggled. */
  changedBy: string | null;
}

export interface KillSwitch {
  /** Current state. Cheap to call; the runner polls this during a run. */
  state(): Promise<KillSwitchState>;
  engage(reason: string, by: string): Promise<KillSwitchState>;
  disengage(by: string): Promise<KillSwitchState>;
  /**
   * Register an in-process listener fired when the switch transitions to engaged.
   * Returns an unsubscribe function. Best-effort and PROCESS-LOCAL: a switch
   * engaged from another process (the CLI/UI) won't fire it — that case is caught
   * by the runner's poll loop. The DB-backed impl returns a no-op unsubscribe.
   */
  onEngage(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'aborted';

/** One autonomous task's lifecycle, as shown in the dashboard activity feed. */
export interface ActivityRecord {
  id: string;
  /** What initiated it: 'manual', 'schedule:<name>', 'webhook:<source>'. */
  trigger: string;
  /** Links to the audit_log run once the agent starts; null if skipped before. */
  runId: string | null;
  status: ActivityStatus;
  detail: string;
  startedAt: string;
  /** Null while still running. */
  finishedAt: string | null;
}

export interface ActivityFeed {
  /** Open a record in the 'running' state and return it. */
  start(entry: { trigger: string; runId?: string | null; detail?: string }): Promise<ActivityRecord>;
  /** Close a record with a terminal status (and optionally backfill its runId). */
  finish(
    id: string,
    update: { status: ActivityStatus; detail?: string; runId?: string | null },
  ): Promise<ActivityRecord | null>;
  /** Most recent records first, capped at `limit` (default 20). */
  recent(limit?: number): Promise<ActivityRecord[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

export class InMemoryKillSwitch implements KillSwitch {
  private current: KillSwitchState = {
    engaged: false,
    reason: null,
    changedAt: new Date().toISOString(),
    changedBy: null,
  };
  private readonly listeners = new Set<() => void>();

  async state(): Promise<KillSwitchState> {
    return { ...this.current };
  }

  async engage(reason: string, by: string): Promise<KillSwitchState> {
    const wasEngaged = this.current.engaged;
    this.current = { engaged: true, reason, changedAt: new Date().toISOString(), changedBy: by };
    // Only fire on a false→true transition, so re-engaging is idempotent.
    if (!wasEngaged) {
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch {
          // A misbehaving listener must not break the toggle.
        }
      }
    }
    return { ...this.current };
  }

  async disengage(by: string): Promise<KillSwitchState> {
    this.current = { engaged: false, reason: null, changedAt: new Date().toISOString(), changedBy: by };
    return { ...this.current };
  }

  onEngage(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class InMemoryActivityFeed implements ActivityFeed {
  private readonly records: ActivityRecord[] = [];

  async start(entry: { trigger: string; runId?: string | null; detail?: string }): Promise<ActivityRecord> {
    const record: ActivityRecord = {
      id: randomUUID(),
      trigger: entry.trigger,
      runId: entry.runId ?? null,
      status: 'running',
      detail: entry.detail ?? '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.records.push(record);
    return { ...record };
  }

  async finish(
    id: string,
    update: { status: ActivityStatus; detail?: string; runId?: string | null },
  ): Promise<ActivityRecord | null> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return null;
    record.status = update.status;
    if (update.detail !== undefined) record.detail = update.detail;
    if (update.runId !== undefined) record.runId = update.runId;
    record.finishedAt = new Date().toISOString();
    return { ...record };
  }

  async recent(limit = 20): Promise<ActivityRecord[]> {
    return this.records
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
