/**
 * Single-user API authentication: a shared API key plus short-lived sessions.
 *
 * ARES is a single-principal system, so auth is intentionally simple and strict:
 *   - One secret API key (ARES_API_KEY). It is the master credential — usable
 *     directly by non-browser clients (CLI, curl, scripts) via the Authorization
 *     header, and exchangeable for a session token at /api/auth/login.
 *   - Session tokens: random, opaque, in-memory, with a TTL. The web dashboard
 *     logs in once with the key and then uses a session token, so the raw key
 *     never has to live in browser storage.
 *
 * Both the key and a live session token are accepted as a request credential.
 * Comparison is constant-time to avoid leaking the key via timing. Sessions are
 * in-memory by design: a single-user control plane has no need to survive a
 * restart with sessions intact, and keeping them out of the DB avoids persisting
 * bearer tokens. A restart simply forces a re-login.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionGrant {
  token: string;
  /** ISO timestamp when the session expires. */
  expiresAt: string;
}

export interface Authenticator {
  /** True when `credential` is the API key or a live session token. */
  authenticate(credential: string | undefined): boolean;
  /** Exchange the API key for a fresh session token, or null if the key is wrong. */
  login(key: string | undefined): SessionGrant | null;
  /** Invalidate a session token (best-effort; unknown tokens are ignored). */
  logout(token: string | undefined): void;
}

export interface ApiKeyAuthenticatorOptions {
  apiKey: string;
  /** Session lifetime in milliseconds. */
  sessionTtlMs: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export class ApiKeyAuthenticator implements Authenticator {
  private readonly apiKey: string;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  /** token → expiry epoch ms. */
  private readonly sessions = new Map<string, number>();

  constructor(opts: ApiKeyAuthenticatorOptions) {
    if (!opts.apiKey) throw new Error('ApiKeyAuthenticator requires a non-empty apiKey');
    this.apiKey = opts.apiKey;
    this.sessionTtlMs = opts.sessionTtlMs;
    this.now = opts.now ?? Date.now;
  }

  authenticate(credential: string | undefined): boolean {
    if (!credential) return false;
    if (this.matchesKey(credential)) return true;
    return this.validSession(credential);
  }

  login(key: string | undefined): SessionGrant | null {
    if (!key || !this.matchesKey(key)) return null;
    this.prune();
    const token = randomBytes(32).toString('base64url');
    const expiry = this.now() + this.sessionTtlMs;
    this.sessions.set(token, expiry);
    return { token, expiresAt: new Date(expiry).toISOString() };
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Number of currently live sessions — for observability/tests. */
  sessionCount(): number {
    this.prune();
    return this.sessions.size;
  }

  private matchesKey(candidate: string): boolean {
    return safeEqual(candidate, this.apiKey);
  }

  private validSession(token: string): boolean {
    const expiry = this.sessions.get(token);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, expiry] of this.sessions) {
      if (expiry <= now) this.sessions.delete(token);
    }
  }
}

/**
 * Extract the bearer credential from a request's headers: `Authorization: Bearer
 * <cred>` or, as a convenience for scripts, `x-api-key: <cred>`. Returns the raw
 * token/key, or undefined when neither is present.
 */
export function extractCredential(headers: {
  authorization?: string | string[] | undefined;
  'x-api-key'?: string | string[] | undefined;
}): string | undefined {
  const auth = first(headers.authorization);
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1]!.trim();
  }
  const apiKeyHeader = first(headers['x-api-key']);
  return apiKeyHeader?.trim() || undefined;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
