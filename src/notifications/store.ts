/**
 * Notification history.
 *
 * The `notify` tool delivers a message to the principal (terminal/push); this
 * store records every delivery so the dashboard can show a history and an unread
 * count. Same shape as the other stores: an interface with an in-memory fallback
 * (no-DB / tests) and a Postgres implementation (schema in migrations/0005), with
 * a `build*` helper that picks one from a Db.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';

export type NotificationUrgency = 'low' | 'normal' | 'high';

export interface Notification {
  id: string;
  title: string;
  body: string;
  urgency: NotificationUrgency;
  /** Run that produced it, or null for manual/system notifications. */
  sourceRun: string | null;
  createdAt: string;
  /** ISO timestamp when marked read, or null while unread. */
  readAt: string | null;
}

export interface NewNotification {
  title: string;
  body: string;
  urgency?: NotificationUrgency;
  sourceRun?: string | null;
}

export interface NotificationStore {
  add(notification: NewNotification): Promise<Notification>;
  /** Most recent first, capped at `limit` (default 50). */
  recent(limit?: number): Promise<Notification[]>;
  /** Mark one read. Returns the updated row, or null if it doesn't exist. */
  markRead(id: string): Promise<Notification | null>;
  /** Count of unread notifications. */
  unreadCount(): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export class InMemoryNotificationStore implements NotificationStore {
  private readonly items: Notification[] = [];

  async add(n: NewNotification): Promise<Notification> {
    const row: Notification = {
      id: randomUUID(),
      title: n.title,
      body: n.body,
      urgency: n.urgency ?? 'normal',
      sourceRun: n.sourceRun ?? null,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    this.items.push(row);
    return { ...row };
  }

  async recent(limit = 50): Promise<Notification[]> {
    return this.items
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async markRead(id: string): Promise<Notification | null> {
    const row = this.items.find((r) => r.id === id);
    if (!row) return null;
    if (!row.readAt) row.readAt = new Date().toISOString();
    return { ...row };
  }

  async unreadCount(): Promise<number> {
    return this.items.filter((r) => !r.readAt).length;
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  urgency: NotificationUrgency;
  source_run: string | null;
  created_at: string;
  read_at: string | null;
}

export class PgNotificationStore implements NotificationStore {
  constructor(private readonly db: Db) {}

  async add(n: NewNotification): Promise<Notification> {
    const res = await this.db.query<NotificationRow>(
      `insert into notifications (title, body, urgency, source_run)
       values ($1, $2, $3, $4)
       returning *`,
      [n.title, n.body, n.urgency ?? 'normal', n.sourceRun ?? null],
    );
    return toNotification(res.rows[0]!);
  }

  async recent(limit = 50): Promise<Notification[]> {
    const res = await this.db.query<NotificationRow>(
      `select * from notifications order by created_at desc limit $1`,
      [limit],
    );
    return res.rows.map(toNotification);
  }

  async markRead(id: string): Promise<Notification | null> {
    const res = await this.db.query<NotificationRow>(
      `update notifications set read_at = coalesce(read_at, now()) where id = $1 returning *`,
      [id],
    );
    return res.rows[0] ? toNotification(res.rows[0]) : null;
  }

  async unreadCount(): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      `select count(*)::text as count from notifications where read_at is null`,
    );
    return Number(res.rows[0]?.count ?? '0');
  }
}

function toNotification(r: NotificationRow): Notification {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    urgency: r.urgency,
    sourceRun: r.source_run,
    createdAt: new Date(r.created_at).toISOString(),
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
  };
}

export function buildNotificationStore(db: Db | undefined): NotificationStore {
  return db ? new PgNotificationStore(db) : new InMemoryNotificationStore();
}
