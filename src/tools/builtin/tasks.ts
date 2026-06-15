/**
 * Task tools: create_task, list_tasks, update_task.
 *
 * These let ARES manage the principal's task list (durable store, schema in
 * migrations/0005). list_tasks is read_only; create_task and update_task mutate
 * persisted state, so — consistent with remember_memory/forget_memory — they are
 * `state_mutating` and pass through the confirmation gate. A standing rule can
 * pre-authorize them for frictionless capture.
 *
 * Built via a factory because they close over the task store.
 */

import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { TASK_PRIORITIES, TASK_STATUSES, type TaskStore } from '../../tasks/store.js';

export function createTaskTools(store: TaskStore): Tool[] {
  const createTask = defineTool({
    name: 'create_task',
    description:
      "Create a task on the principal's task list. Use when the user asks to be reminded of, " +
      'or to track, something actionable. Mutates durable state, so it is gated.',
    kind: 'state_mutating',
    schema: z.object({
      title: z.string().describe('Short imperative title of the task.'),
      detail: z.string().describe('Optional longer description or context.').optional(),
      priority: z.enum(TASK_PRIORITIES).describe('Defaults to "normal".').optional(),
      project: z.string().describe('Optional project/grouping this belongs to.').optional(),
      due_at: z.string().describe('Optional ISO 8601 due date/time.').optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const due = normalizeDate(input.due_at);
      if (input.due_at && !due) return { ok: false, content: `due_at "${input.due_at}" is not a valid date.` };
      const task = await store.create({
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.project !== undefined ? { project: input.project } : {}),
        ...(due ? { dueAt: due } : {}),
        sourceRun: ctx.runId,
      });
      return { ok: true, content: `Created task "${task.title}" (id ${task.id}).`, data: { id: task.id } };
    },
  });

  const listTasks = defineTool({
    name: 'list_tasks',
    description:
      "List the principal's tasks, newest first. Optionally filter by status " +
      `(${TASK_STATUSES.join(', ')}). Use before updating a task to find its id.`,
    kind: 'read_only',
    schema: z.object({
      status: z.enum(TASK_STATUSES).describe('Optional status filter.').optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const tasks = await store.list({
        ...(input.status ? { status: [input.status] } : {}),
        limit: 50,
      });
      if (tasks.length === 0) return { ok: true, content: 'No tasks found.', data: { count: 0 } };
      const summary = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        ...(t.dueAt ? { dueAt: t.dueAt } : {}),
        ...(t.project ? { project: t.project } : {}),
      }));
      return { ok: true, content: JSON.stringify(summary), data: { count: tasks.length } };
    },
  });

  const updateTask = defineTool({
    name: 'update_task',
    description:
      'Update a task by id — change its status (e.g. mark it done or in_progress), title, ' +
      'priority, detail, or due date. Call list_tasks first to find the id. Gated.',
    kind: 'state_mutating',
    schema: z.object({
      id: z.string().describe('Exact task id from list_tasks.'),
      status: z.enum(TASK_STATUSES).optional(),
      title: z.string().optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      detail: z.string().optional(),
      due_at: z.string().describe('ISO 8601 due date/time.').optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const due = normalizeDate(input.due_at);
      if (input.due_at && !due) return { ok: false, content: `due_at "${input.due_at}" is not a valid date.` };
      const updated = await store.update(input.id, {
        ...(input.status ? { status: input.status } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(due ? { dueAt: due } : {}),
      });
      return updated
        ? { ok: true, content: `Updated task "${updated.title}" → ${updated.status}.`, data: { id: updated.id } }
        : { ok: false, content: `No task exists with id ${input.id}.` };
    },
  });

  return [createTask, listTasks, updateTask];
}

/** Validate a date string and return it as an ISO timestamp, or null if invalid. */
function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
