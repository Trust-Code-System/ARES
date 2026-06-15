/**
 * State-mutating example tool: push a notification to the user.
 *
 * "Delivery" is a styled terminal write for now, but it is declared
 * `state_mutating` so it exercises the confirmation gate and the audit trail —
 * the same path a real `send_email` will take. When a {@link NotificationStore}
 * is provided, each delivery is also recorded so the dashboard can show history
 * and an unread count. Built via a factory so it can close over the store; the
 * tool name stays `notify` (briefings and standing rules reference it by name).
 */

import { stdout } from 'node:process';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import type { NotificationStore } from '../../notifications/store.js';

export interface NotifyToolOptions {
  /** When set, deliveries are persisted to the notification history. */
  store?: NotificationStore;
}

export function createNotifyTool(opts: NotifyToolOptions = {}): Tool {
  return defineTool({
    name: 'notify',
    description:
      "Send a notification to the user's device. Use for surfacing summaries, " +
      'alerts, or anything the user asked to be told. This contacts the user, so it ' +
      'requires confirmation unless a standing rule pre-authorizes it.',
    kind: 'state_mutating',
    schema: z.object({
      title: z.string().describe('Short headline.'),
      body: z.string().describe('The notification body.'),
      urgency: z.enum(['low', 'normal', 'high']).describe('Defaults to "normal".').optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const urgency = input.urgency ?? 'normal';
      const color = urgency === 'high' ? '\x1b[31m' : urgency === 'low' ? '\x1b[90m' : '\x1b[32m';
      stdout.write(
        `\n${color}🔔 [${urgency.toUpperCase()}] ${input.title}\x1b[0m\n   ${input.body}\n`,
      );
      ctx.logger.info('notification delivered', { title: input.title, urgency });

      // Record history best-effort: a store failure must not fail the delivery
      // that the user already saw.
      if (opts.store) {
        try {
          await opts.store.add({
            title: input.title,
            body: input.body,
            urgency,
            sourceRun: ctx.runId,
          });
        } catch (err) {
          ctx.logger.warn('failed to record notification history', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        ok: true,
        content: `Notification "${input.title}" delivered to the user.`,
        data: { title: input.title, urgency },
      };
    },
  });
}
