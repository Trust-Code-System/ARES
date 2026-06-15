/**
 * web_fetch — retrieve a URL and return readable text.
 *
 * Read-only (no gate). Guards against the foot-guns of fetching arbitrary URLs
 * from an agent: http(s) only, an SSRF guard (private/loopback/link-local/cloud-
 * metadata addresses are blocked — see net/ssrf.ts), a request timeout, a
 * response size cap, and a naive HTML→text reduction so the model gets prose
 * rather than markup. Redirects are followed manually so the SSRF guard runs on
 * every hop, not just the first URL.
 */

import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { assertPublicUrl, SsrfError } from '../net/ssrf.js';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const webFetch = defineTool({
  name: 'web_fetch',
  description:
    'Fetch a single http(s) URL and return its text content (HTML is reduced to ' +
    'readable text). Use for reading a specific page you already have the URL for; ' +
    'use web_search to find URLs first.',
  kind: 'read_only',
  schema: z.object({ url: z.string().describe('Absolute http(s) URL.') }),
  async execute(input, ctx): Promise<ToolResult> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, content: `Not a valid URL: ${input.url}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, content: `Only http(s) URLs are allowed (got ${url.protocol}).` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onParentAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      const res = await fetchFollowing(url, controller.signal);
      if (!res.ok) {
        return { ok: false, content: `Fetch failed: HTTP ${res.status} ${res.statusText}` };
      }

      const text = await readCapped(res, MAX_BYTES);
      const contentType = res.headers.get('content-type') ?? '';
      const body = contentType.includes('html') ? htmlToText(text) : text;
      return {
        ok: true,
        content: body.trim() || '(empty response body)',
        data: { url: res.url || url.toString(), contentType, bytes: text.length },
      };
    } catch (err) {
      if (err instanceof SsrfError) return { ok: false, content: err.message };
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Fetch error: ${message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onParentAbort);
    }
  },
});

/**
 * Fetch `start`, following redirects manually so the SSRF guard runs on every
 * hop. Each target is validated (host resolves to public addresses only) before
 * the connection is made.
 */
async function fetchFollowing(start: URL, signal: AbortSignal): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      signal,
      headers: { 'user-agent': 'ARES/0.1 (+personal-assistant)' },
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res; // a 3xx without Location — hand it back as-is
    const next = new URL(location, current);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new SsrfError(next.hostname, `redirect to non-http(s) scheme ${next.protocol}`);
    }
    current = next;
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`);
}

/** Read a response body, stopping once `maxBytes` have been collected. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return out;
}

/** Strip scripts/styles/tags and collapse whitespace — a deliberately naive reducer. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
