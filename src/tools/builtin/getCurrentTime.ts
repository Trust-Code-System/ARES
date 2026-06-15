/** Read-only example tool: returns the current date/time. */

import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export const getCurrentTime = defineTool({
  name: 'get_current_time',
  description:
    'Get the current date and time. Optionally pass an IANA timezone (e.g. "America/New_York") to localize it.',
  kind: 'read_only',
  schema: z.object({
    timezone: z
      .string()
      .describe('IANA timezone name. Defaults to the host timezone.')
      .optional(),
  }),
  async execute(input): Promise<ToolResult> {
    const now = new Date();
    try {
      const formatted = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'full',
        timeStyle: 'long',
        ...(input.timezone ? { timeZone: input.timezone } : {}),
      }).format(now);
      return {
        ok: true,
        content: formatted,
        data: { iso: now.toISOString(), timezone: input.timezone ?? 'host' },
      };
    } catch {
      return {
        ok: false,
        content: `Invalid timezone: "${input.timezone}". Use an IANA name like "Europe/London".`,
      };
    }
  },
});
