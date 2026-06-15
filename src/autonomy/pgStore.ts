/**
 * Postgres-backed autonomy control plane — the durable path for the kill switch
 * and the activity feed (schema in migrations/0003). Thin SQL; the runner holds
 * all behaviour.
 *
 * Note on {@link PgKillSwitch.onEngage}: there is no in-process event to hook
 * when the switch is engaged from another process (the CLI/UI writing to the same
 * row), so it returns a no-op unsubscribe. The runner detects cross-process
 * engagement by polling {@link PgKillSwitch.state} on an interval.
 */

import type { Db } from '../db/client.js';
import type {
  ActivityFeed,
  ActivityRecord,
  ActivityStatus,
  KillSwitch,
  KillSwitchState,
} from './store.js';

export class PgKillSwitch implements KillSwitch {
  constructor(private readonly db: Db) {}

  async state(): Promise<KillSwitchState> {
    const res = await this.db.query<KillSwitchRow>(
      `select engaged, reason, changed_at, changed_by from kill_switch where id = true`,
    );
    // The migration seeds the singleton row; treat a missing row as "running".
    return res.rows[0] ? toState(res.rows[0]) : defaultState();
  }

  async engage(reason: string, by: string): Promise<KillSwitchState> {
    const res = await this.db.query<KillSwitchRow>(
      `update kill_switch
          set engaged = true, reason = $1, changed_at = now(), changed_by = $2
        where id = true
        returning engaged, reason, changed_at, changed_by`,
      [reason, by],
    );
    return res.rows[0] ? toState(res.rows[0]) : defaultState();
  }

  async disengage(by: string): Promise<KillSwitchState> {
    const res = await this.db.query<KillSwitchRow>(
      `update kill_switch
          set engaged = false, reason = null, changed_at = now(), changed_by = $1
        where id = true
        returning engaged, reason, changed_at, changed_by`,
      [by],
    );
    return res.rows[0] ? toState(res.rows[0]) : defaultState();
  }

  onEngage(): () => void {
    // Cross-process engagement is detected by the runner's poll loop, not events.
    return () => {};
  }
}

export class PgActivityFeed implements ActivityFeed {
  constructor(private readonly db: Db) {}

  async start(entry: { trigger: string; runId?: string | null; detail?: string }): Promise<ActivityRecord> {
    const res = await this.db.query<ActivityRow>(
      `insert into activity_feed (trigger, run_id, status, detail)
       values ($1, $2, 'running', $3)
       returning *`,
      [entry.trigger, entry.runId ?? null, entry.detail ?? ''],
    );
    return toRecord(res.rows[0]!);
  }

  async finish(
    id: string,
    update: { status: ActivityStatus; detail?: string; runId?: string | null },
  ): Promise<ActivityRecord | null> {
    // COALESCE leaves detail/run_id untouched when the caller omits them.
    const res = await this.db.query<ActivityRow>(
      `update activity_feed
          set status = $2,
              detail = coalesce($3, detail),
              run_id = coalesce($4, run_id),
              finished_at = now()
        where id = $1
        returning *`,
      [id, update.status, update.detail ?? null, update.runId ?? null],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async recent(limit = 20): Promise<ActivityRecord[]> {
    const res = await this.db.query<ActivityRow>(
      `select * from activity_feed order by started_at desc limit $1`,
      [limit],
    );
    return res.rows.map(toRecord);
  }
}

interface KillSwitchRow {
  engaged: boolean;
  reason: string | null;
  changed_at: string;
  changed_by: string | null;
}

interface ActivityRow {
  id: string;
  trigger: string;
  run_id: string | null;
  status: ActivityStatus;
  detail: string;
  started_at: string;
  finished_at: string | null;
}

function defaultState(): KillSwitchState {
  return { engaged: false, reason: null, changedAt: new Date(0).toISOString(), changedBy: null };
}

function toState(r: KillSwitchRow): KillSwitchState {
  return {
    engaged: r.engaged,
    reason: r.reason,
    changedAt: new Date(r.changed_at).toISOString(),
    changedBy: r.changed_by,
  };
}

function toRecord(r: ActivityRow): ActivityRecord {
  return {
    id: r.id,
    trigger: r.trigger,
    runId: r.run_id,
    status: r.status,
    detail: r.detail,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}
