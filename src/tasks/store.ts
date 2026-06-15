/**
 * Task store — the principal's actionable items that ARES creates and manages.
 *
 * Same shape as the other stores: an interface with an in-memory fallback and a
 * Postgres implementation (schema in migrations/0005), plus a `build*` helper.
 * Setting status to 'done' stamps completedAt; clearing it back removes the stamp.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  detail: string;
  project: string | null;
  dueAt: string | null;
  sourceRun: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NewTask {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  detail?: string;
  project?: string | null;
  dueAt?: string | null;
  sourceRun?: string | null;
}

/** Partial mutation of an existing task. Undefined fields are left untouched. */
export interface TaskUpdate {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  detail?: string;
  project?: string | null;
  dueAt?: string | null;
}

export interface TaskStore {
  create(task: NewTask): Promise<Task>;
  /** Tasks, newest first. Filter by status when provided. */
  list(filter?: { status?: TaskStatus[]; limit?: number }): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  /** Apply a partial update. Returns the updated row, or null if it doesn't exist. */
  update(id: string, update: TaskUpdate): Promise<Task | null>;
  remove(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();

  async create(task: NewTask): Promise<Task> {
    const now = new Date().toISOString();
    const status = task.status ?? 'todo';
    const row: Task = {
      id: randomUUID(),
      title: task.title,
      status,
      priority: task.priority ?? 'normal',
      detail: task.detail ?? '',
      project: task.project ?? null,
      dueAt: task.dueAt ?? null,
      sourceRun: task.sourceRun ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: status === 'done' ? now : null,
    };
    this.tasks.set(row.id, row);
    return { ...row };
  }

  async list(filter?: { status?: TaskStatus[]; limit?: number }): Promise<Task[]> {
    const all = [...this.tasks.values()]
      .filter((t) => !filter?.status || filter.status.includes(t.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return (filter?.limit ? all.slice(0, filter.limit) : all).map((t) => ({ ...t }));
  }

  async get(id: string): Promise<Task | null> {
    const row = this.tasks.get(id);
    return row ? { ...row } : null;
  }

  async update(id: string, update: TaskUpdate): Promise<Task | null> {
    const row = this.tasks.get(id);
    if (!row) return null;
    if (update.title !== undefined) row.title = update.title;
    if (update.priority !== undefined) row.priority = update.priority;
    if (update.detail !== undefined) row.detail = update.detail;
    if (update.project !== undefined) row.project = update.project;
    if (update.dueAt !== undefined) row.dueAt = update.dueAt;
    if (update.status !== undefined) {
      row.status = update.status;
      row.completedAt = update.status === 'done' ? (row.completedAt ?? new Date().toISOString()) : null;
    }
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }

  async remove(id: string): Promise<boolean> {
    return this.tasks.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  detail: string;
  project: string | null;
  due_at: string | null;
  source_run: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class PgTaskStore implements TaskStore {
  constructor(private readonly db: Db) {}

  async create(task: NewTask): Promise<Task> {
    const status = task.status ?? 'todo';
    const res = await this.db.query<TaskRow>(
      `insert into tasks (title, status, priority, detail, project, due_at, source_run, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, case when $2 = 'done' then now() else null end)
       returning *`,
      [
        task.title,
        status,
        task.priority ?? 'normal',
        task.detail ?? '',
        task.project ?? null,
        task.dueAt ?? null,
        task.sourceRun ?? null,
      ],
    );
    return toTask(res.rows[0]!);
  }

  async list(filter?: { status?: TaskStatus[]; limit?: number }): Promise<Task[]> {
    const limit = filter?.limit ?? 200;
    if (filter?.status?.length) {
      const res = await this.db.query<TaskRow>(
        `select * from tasks where status = any($1) order by created_at desc limit $2`,
        [filter.status, limit],
      );
      return res.rows.map(toTask);
    }
    const res = await this.db.query<TaskRow>(
      `select * from tasks order by created_at desc limit $1`,
      [limit],
    );
    return res.rows.map(toTask);
  }

  async get(id: string): Promise<Task | null> {
    const res = await this.db.query<TaskRow>(`select * from tasks where id = $1`, [id]);
    return res.rows[0] ? toTask(res.rows[0]) : null;
  }

  async update(id: string, update: TaskUpdate): Promise<Task | null> {
    // COALESCE leaves a column untouched when the corresponding param is null.
    // completed_at is recomputed from the resulting status.
    const res = await this.db.query<TaskRow>(
      `update tasks set
          title    = coalesce($2, title),
          status   = coalesce($3, status),
          priority = coalesce($4, priority),
          detail   = coalesce($5, detail),
          project  = case when $6::boolean then $7 else project end,
          due_at   = case when $8::boolean then $9 else due_at end,
          completed_at = case
            when coalesce($3, status) = 'done' then coalesce(completed_at, now())
            else null end,
          updated_at = now()
        where id = $1
        returning *`,
      [
        id,
        update.title ?? null,
        update.status ?? null,
        update.priority ?? null,
        update.detail ?? null,
        update.project !== undefined,
        update.project ?? null,
        update.dueAt !== undefined,
        update.dueAt ?? null,
      ],
    );
    return res.rows[0] ? toTask(res.rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.db.query(`delete from tasks where id = $1`, [id]);
    return res.rowCount > 0;
  }
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    detail: r.detail,
    project: r.project,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    sourceRun: r.source_run,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

export function buildTaskStore(db: Db | undefined): TaskStore {
  return db ? new PgTaskStore(db) : new InMemoryTaskStore();
}
