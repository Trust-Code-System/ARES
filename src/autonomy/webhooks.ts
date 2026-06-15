/**
 * Webhook trigger layer — let external events wake ARES.
 *
 * A small HTTP endpoint (`POST /webhook/<source>`) turns an inbound event into an
 * {@link AutonomousTask} and runs it through the {@link AutonomousRunner}, so a
 * webhook-triggered run is gated by the kill switch and recorded on the activity
 * feed exactly like a scheduled one. Nothing here can mutate state without passing
 * the confirmation gate inside the agent loop.
 *
 * Security posture (fail-closed):
 *   - A shared secret is REQUIRED; the server refuses to start without one, so an
 *     unauthenticated trigger is never exposed.
 *   - Every request is checked with a timing-safe comparison of the `x-ares-token`
 *     header (or `?token=`), and the body size is capped.
 *
 * The request logic lives in {@link WebhookHandler} (pure, unit-tested); the thin
 * {@link WebhookServer} just plumbs node:http into it.
 */

import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AgentInput, Logger } from '../types.js';
import type { AutonomousRunResult, AutonomousRunner } from './runner.js';

const MAX_BODY_BYTES = 256 * 1024;

export interface WebhookRequest {
  method: string;
  /** Path portion of the URL, e.g. "/webhook/github". */
  path: string;
  token?: string;
  body: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
  /** The background run kicked off by an accepted request (for tests/shutdown). */
  dispatched?: Promise<AutonomousRunResult>;
}

export class WebhookHandler {
  constructor(
    private readonly opts: { runner: AutonomousRunner; secret: string; logger: Logger },
  ) {}

  handle(req: WebhookRequest): WebhookResponse {
    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });

    const source = parseSource(req.path);
    if (!source) return reply(404, { error: 'not found' });

    if (!this.authorized(req.token)) {
      this.opts.logger.warn('webhook rejected (bad token)', { source });
      return reply(401, { error: 'unauthorized' });
    }

    let payload: unknown = {};
    if (req.body) {
      try {
        payload = JSON.parse(req.body);
      } catch {
        return reply(400, { error: 'invalid JSON body' });
      }
    }

    const task = buildTask(source, payload);
    // Fire-and-forget: respond fast (senders expect a quick 2xx). The runner
    // never throws — it records failures on the activity feed — but attach a
    // catch so a rejection can't become an unhandled rejection.
    const dispatched = this.opts.runner.run(task);
    dispatched.catch(() => {});
    this.opts.logger.info('webhook accepted', { source, trigger: task.trigger });
    return { ...reply(202, { accepted: true, trigger: task.trigger }), dispatched };
  }

  private authorized(token: string | undefined): boolean {
    if (!token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.opts.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** `/webhook/<source>` → `<source>`; anything else → null. */
function parseSource(path: string): string | null {
  const match = path.replace(/\/+$/, '').match(/^\/webhook\/([A-Za-z0-9_-]+)$/);
  return match ? match[1]! : null;
}

function buildTask(source: string, payload: unknown): { trigger: string; input: AgentInput } {
  const prompt =
    payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).prompt === 'string'
      ? ((payload as Record<string, unknown>).prompt as string)
      : `An external event arrived via the "${source}" webhook. Payload:\n${safeJson(payload)}\n` +
        `Decide whether any action is warranted and, if so, carry it out. If not, briefly note why.`;
  return { trigger: `webhook:${source}`, input: { text: prompt, source: 'event' } };
}

function reply(status: number, body: unknown): WebhookResponse {
  return { status, body: JSON.stringify(body) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable payload]';
  }
}

/** Thin node:http wrapper around {@link WebhookHandler}. */
export class WebhookServer {
  private server?: Server;
  private readonly handler: WebhookHandler;

  constructor(
    private readonly opts: { runner: AutonomousRunner; secret: string; port: number; logger: Logger },
  ) {
    if (!opts.secret) throw new Error('WebhookServer requires a non-empty secret (refusing to start unauthenticated).');
    this.handler = new WebhookHandler({ runner: opts.runner, secret: opts.secret, logger: opts.logger });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        const url = new URL(req.url ?? '/', 'http://localhost');
        const token = req.headers['x-ares-token'];
        const result = this.handler.handle({
          method: req.method ?? 'GET',
          path: url.pathname,
          token: (Array.isArray(token) ? token[0] : token) ?? url.searchParams.get('token') ?? undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(result.body);
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, resolve));
    this.opts.logger.info('webhook server listening', { port: this.opts.port });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.opts.logger.info('webhook server stopped');
  }
}
