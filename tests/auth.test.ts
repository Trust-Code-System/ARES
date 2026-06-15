/**
 * API authentication. Two layers, both offline:
 *   - ApiKeyAuthenticator unit behaviour (key match, session mint/expiry, logout).
 *   - The HTTP auth gate on a real ApiServer (ephemeral port): 401 without a
 *     credential, login → token → access, health stays public, bad key rejected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApiKeyAuthenticator,
  extractCredential,
} from '../src/server/auth.js';
import { ApiServer } from '../src/server/httpServer.js';
import type { ApiDeps } from '../src/server/api.js';
import { InMemoryActivityFeed, InMemoryKillSwitch } from '../src/autonomy/store.js';
import { InMemoryConfirmationQueue, InMemoryRulesStore } from '../src/safety/store.js';
import { InMemoryStructuredStore } from '../src/memory/stores.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { AgentInput, AgentRunResult, Logger } from '../src/types.js';

const KEY = 'test-api-key-0123456789';
const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

function deps(): ApiDeps {
  return {
    agent: {
      async run(input: AgentInput): Promise<AgentRunResult> {
        return { runId: 'r', finalText: `echo:${input.text}`, stopReason: 'completed', iterations: 1, toolCalls: [] };
      },
    },
    audit: new InMemoryAuditLog(),
    activityFeed: new InMemoryActivityFeed(),
    killSwitch: new InMemoryKillSwitch(),
    rules: new InMemoryRulesStore(),
    queue: new InMemoryConfirmationQueue(),
    structured: new InMemoryStructuredStore(),
    registry: new ToolRegistry(),
  };
}

describe('ApiKeyAuthenticator', () => {
  it('accepts the API key directly and rejects wrong/empty credentials', () => {
    const auth = new ApiKeyAuthenticator({ apiKey: KEY, sessionTtlMs: 1000 });
    assert.equal(auth.authenticate(KEY), true);
    assert.equal(auth.authenticate('wrong'), false);
    assert.equal(auth.authenticate(undefined), false);
    assert.equal(auth.authenticate(''), false);
  });

  it('mints a session for the right key and validates the token', () => {
    const auth = new ApiKeyAuthenticator({ apiKey: KEY, sessionTtlMs: 1000 });
    assert.equal(auth.login('nope'), null);
    const grant = auth.login(KEY);
    assert.ok(grant);
    assert.equal(auth.authenticate(grant!.token), true);
    assert.equal(auth.sessionCount(), 1);
  });

  it('expires sessions and supports logout', () => {
    let now = 1_000_000;
    const auth = new ApiKeyAuthenticator({ apiKey: KEY, sessionTtlMs: 100, now: () => now });
    const grant = auth.login(KEY)!;
    assert.equal(auth.authenticate(grant.token), true);
    now += 101; // past TTL
    assert.equal(auth.authenticate(grant.token), false);

    const fresh = auth.login(KEY)!;
    assert.equal(auth.authenticate(fresh.token), true);
    auth.logout(fresh.token);
    assert.equal(auth.authenticate(fresh.token), false);
  });

  it('extracts credentials from Authorization and x-api-key headers', () => {
    assert.equal(extractCredential({ authorization: 'Bearer abc' }), 'abc');
    assert.equal(extractCredential({ authorization: 'bearer xyz ' }), 'xyz');
    assert.equal(extractCredential({ 'x-api-key': 'k1' }), 'k1');
    assert.equal(extractCredential({ authorization: 'Basic foo' }), undefined);
    assert.equal(extractCredential({}), undefined);
  });
});

describe('HTTP auth gate', () => {
  async function withServer(run: (base: string) => Promise<void>): Promise<void> {
    const authenticator = new ApiKeyAuthenticator({ apiKey: KEY, sessionTtlMs: 60_000 });
    const server = new ApiServer({ deps: deps(), port: 0, logger: silentLogger, authenticator });
    await server.start();
    try {
      await run(`http://localhost:${server.address()}`);
    } finally {
      await server.stop();
    }
  }

  it('keeps /api/health public but 401s a protected endpoint without a credential', async () => {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      const status = await fetch(`${base}/api/status`);
      assert.equal(status.status, 401);
      assert.match(status.headers.get('www-authenticate') ?? '', /Bearer/);
    });
  });

  it('logs in with the key and then authorizes with the session token', async () => {
    await withServer(async (base) => {
      const bad = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'wrong' }),
      });
      assert.equal(bad.status, 401);

      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: KEY }),
      });
      assert.equal(login.status, 200);
      const { token } = (await login.json()) as { token: string; expiresAt: string };
      assert.ok(token);

      const ok = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(ok.status, 200);

      // The raw key also works as a direct credential (CLI/curl path).
      const withKey = await fetch(`${base}/api/status`, { headers: { 'x-api-key': KEY } });
      assert.equal(withKey.status, 200);
    });
  });

  it('invalidates a session on logout', async () => {
    await withServer(async (base) => {
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: KEY }),
      });
      const { token } = (await login.json()) as { token: string };
      const headers = { authorization: `Bearer ${token}` };

      assert.equal((await fetch(`${base}/api/status`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })).status, 200);
      assert.equal((await fetch(`${base}/api/status`, { headers })).status, 401);
    });
  });

  it('protects the chat stream endpoint too', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 401);
    });
  });
});
