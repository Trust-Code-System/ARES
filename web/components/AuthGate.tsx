'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, getSessionToken, login, logout, UnauthorizedError } from '@/lib/api';

type Phase = 'checking' | 'authed' | 'needkey';

/**
 * Gates the dashboard behind the ARES API auth.
 *
 * On mount it probes an authenticated endpoint:
 *   - success            → render the app.
 *   - UnauthorizedError  → the server requires a key; show the login form.
 *   - any other error    → the server is down or erroring; render the app so its
 *                          own "offline" UI takes over (don't block on a network blip).
 *
 * When a session is active it also shows a small lock control to sign out.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const probe = useCallback(async () => {
    try {
      await api.status();
      setPhase('authed');
    } catch (caught) {
      setPhase(caught instanceof UnauthorizedError ? 'needkey' : 'authed');
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(key.trim());
      setKey('');
      await probe();
    } catch (caught) {
      setError(caught instanceof UnauthorizedError ? 'Invalid API key' : 'Login failed — is the API running?');
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    await logout();
    setPhase('needkey');
  }

  if (phase === 'checking') {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="thinking-shimmer font-mono text-xs uppercase tracking-[0.28em] text-ares-cyan">
          Establishing secure link...
        </div>
      </div>
    );
  }

  if (phase === 'needkey') {
    return (
      <div className="grid min-h-[70vh] place-items-center px-4">
        <form onSubmit={submit} className="hud-panel w-full max-w-md p-7" aria-labelledby="auth-title">
          <div id="auth-title" className="mb-1 font-mono text-xs uppercase tracking-[0.28em] text-ares-cyan">
            Authentication required
          </div>
          <p className="mb-5 text-sm leading-6 text-slate-400">
            Enter the ARES API key to open a session. The key is exchanged for a short-lived
            session token; it is never stored in the browser.
          </p>
          <label htmlFor="api-key" className="hud-label">API key</label>
          <input
            id="api-key"
            type="password"
            autoComplete="current-password"
            className="hud-input mt-2 h-11 w-full px-3"
            placeholder="ARES_API_KEY"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={submitting}
            autoFocus
          />
          {error && (
            <div role="alert" className="mt-3 border border-ares-red/50 bg-ares-red/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-red-200">
              {error}
            </div>
          )}
          <button type="submit" className="hud-button mt-5 w-full" disabled={submitting || !key.trim()}>
            {submitting ? 'Authenticating' : 'Establish session'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      {children}
      {getSessionToken() && (
        <button
          type="button"
          onClick={() => void signOut()}
          title="End session"
          aria-label="End session"
          className="fixed bottom-4 right-4 z-50 border border-ares-line bg-ares-bg/90 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-ares-muted backdrop-blur transition hover:border-ares-red/50 hover:text-ares-red"
        >
          Lock
        </button>
      )}
    </>
  );
}
