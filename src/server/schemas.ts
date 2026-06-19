/**
 * Zod schemas for HTTP request bodies.
 *
 * One place that validates everything coming off the wire, replacing the
 * hand-written type guards the handlers used to carry. Each schema is the
 * contract for an endpoint's body; {@link parseBody} runs it and yields either
 * the typed data or a ready-to-return 400 with a readable message.
 */

import { z } from 'zod';
import { formatZodError } from '../tools/define.js';
import { ASSISTANT_MODES } from '../agent/modes.js';
import { EFFORT_LEVELS } from '../agent/effort.js';
import { STRUCTURED_KINDS } from '../memory/types.js';
import { TASK_PRIORITIES, TASK_STATUSES } from '../tasks/store.js';

export const chatSchema = z.object({
  text: z.string().trim().min(1, 'body.text is required'),
  mode: z.enum(ASSISTANT_MODES).optional(),
  /** Per-turn model choice: `auto`, `fast`/`smart`, or `<provider>:<tier>`. */
  model: z.string().max(40).optional(),
  /** Per-turn response depth: `quick`, `standard`, or `deep`. */
  effort: z.enum(EFFORT_LEVELS).optional(),
  /** Prior turns for multi-turn context, oldest first. Capped to keep payloads sane. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .max(40)
    .optional(),
});

export const rememberSchema = z.object({
  kind: z.enum(STRUCTURED_KINDS),
  subject: z.string().trim().min(1, 'body.subject is required'),
  content: z.string().trim().min(1, 'body.content is required'),
  importance: z.number().min(0).max(1).optional(),
});

export const confirmationSchema = z.object({
  decision: z.enum(['approved', 'denied']),
});

export const killSwitchSchema = z.object({
  engaged: z.boolean(),
  reason: z.string().optional(),
});

export const toggleToolSchema = z.object({
  enabled: z.boolean(),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'body.title is required'),
  detail: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  project: z.string().optional(),
  dueAt: z.string().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  detail: z.string().optional(),
  project: z.string().optional(),
  dueAt: z.string().optional(),
});

export const loginSchema = z.object({
  key: z.string().min(1),
});

export const speakSchema = z.object({
  text: z.string().min(1),
});

/** Result of validating a body: the typed data, or a 400 response to return. */
export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Validate `body` against `schema`, returning typed data or a readable error. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, error: formatZodError(result.error) };
}
