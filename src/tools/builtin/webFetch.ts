/**
 * web_fetch — retrieve a URL and return readable text.
 *
 * Read-only (no gate). The retrieval, SSRF guard, timeout, size cap, and
 * HTML→text reduction all live in the shared {@link fetchReadablePage} helper so
 * `web_fetch` and `deep_research` behave identically. This tool is the thin
 * wrapper that turns that into a {@link ToolResult}.
 */

import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { fetchReadablePage, SsrfError } from '../net/fetchPage.js';

export const webFetch = defineTool({
  name: 'web_fetch',
  description:
    'Fetch a single http(s) URL and return its text content (HTML is reduced to ' +
    'readable text). Use for reading a specific page you already have the URL for; ' +
    'use web_search to find URLs first.',
  kind: 'read_only',
  schema: z.object({ url: z.string().describe('Absolute http(s) URL.') }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const page = await fetchReadablePage(input.url, ctx.signal ? { signal: ctx.signal } : {});
      return {
        ok: true,
        content: page.text || '(empty response body)',
        data: { url: page.url, contentType: page.contentType, bytes: page.text.length },
      };
    } catch (err) {
      if (err instanceof SsrfError) return { ok: false, content: err.message };
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: message };
    }
  },
});
