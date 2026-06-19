/**
 * Shared, SSRF-guarded page fetcher.
 *
 * The `web_fetch` tool and the `deep_research` tool both need to retrieve a URL
 * and reduce it to readable text under the exact same safety envelope: http(s)
 * only, the SSRF guard re-run on every redirect hop, a request timeout, a
 * response-size cap, and a naive HTML→text reduction. That logic lives here once
 * so both callers share identical behaviour (and the SSRF guarantees can't drift
 * apart between them).
 */

import { assertPublicUrl, SsrfError } from './ssrf.js';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export { SsrfError };

/** A retrieved page reduced to readable text. */
export interface FetchedPage {
  /** The final URL after any redirects. */
  url: string;
  contentType: string;
  /** Readable text (HTML reduced to prose), capped to the byte limit. */
  text: string;
}

export interface FetchPageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetch `rawUrl` and return its readable text. Throws on a non-http(s) scheme,
 * an invalid URL, an SSRF-blocked host ({@link SsrfError}), an HTTP error, or a
 * network failure — callers decide how to surface those.
 */
export async function fetchReadablePage(
  rawUrl: string,
  opts: FetchPageOptions = {},
): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol}).`);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const res = await fetchFollowing(url, controller.signal);
    if (!res.ok) {
      throw new Error(`Fetch failed: HTTP ${res.status} ${res.statusText}`);
    }
    const raw = await readCapped(res, maxBytes);
    const contentType = res.headers.get('content-type') ?? '';
    const text = contentType.includes('html') ? htmlToText(raw) : raw;
    return { url: res.url || url.toString(), contentType, text: text.trim() };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}

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
export function htmlToText(html: string): string {
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
