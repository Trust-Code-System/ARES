/**
 * node:http adapter around {@link ApiHandler}.
 *
 * Plumbs requests/JSON bodies into the pure handler and writes JSON back, with
 * an explicit CORS allowlist so the Next.js dev server can call it without
 * exposing control-plane endpoints to arbitrary browser origins. It
 * also exposes one streaming endpoint, `POST /api/chat/stream`, as Server-Sent
 * Events: model text and audit events are forwarded live from the orchestrator.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../types.js';
import { ApiHandler, type ApiDeps } from './api.js';
import { extractCredential, type Authenticator } from './auth.js';
import { extractUpload } from './extract.js';
import { chatSchema, parseBody, speakSchema } from './schemas.js';

const MAX_BODY_BYTES = 1024 * 1024;
/** File uploads (PDFs, spreadsheets, images) are larger than chat/voice bodies. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

export class ApiServer {
  private server?: Server;
  private readonly handler: ApiHandler;

  constructor(
    private readonly opts: {
      deps: ApiDeps;
      port: number;
      logger: Logger;
      host?: string;
      allowedOrigins?: string[];
      /** When set, every endpoint except /api/health and /api/auth/login requires a valid credential. */
      authenticator?: Authenticator;
    },
  ) {
    this.handler = new ApiHandler(opts.deps);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.onRequest(req, res).catch((error: unknown) => this.requestFailed(error, res));
    });
    const host = this.opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, host, resolve));
    this.opts.logger.info('api server listening', { host, port: this.opts.port });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** The actual bound port — useful when started on port 0 (tests). */
  address(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = header(req, 'origin');
    if (origin && !this.allowedOrigins().includes(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }
    cors(res, origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    // --- Authentication gate ---------------------------------------------------
    // Active only when an authenticator is configured (a key is set). /api/health
    // stays public (connectivity probe) and /api/auth/login is how you get in;
    // everything else — including streaming and voice — requires a credential.
    if (this.opts.authenticator) {
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        await this.login(req, res);
        return;
      }
      const isPublic = req.method === 'GET' && url.pathname === '/api/health';
      if (!isPublic) {
        const credential = extractCredential(req.headers);
        if (!this.opts.authenticator.authenticate(credential)) {
          res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
          this.opts.authenticator.logout(credential);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
    }

    // Voice endpoints carry binary audio, so they're handled before JSON parsing.
    if (req.method === 'POST' && url.pathname === '/api/voice/transcribe') {
      await this.transcribe(req, res);
      return;
    }

    // File uploads also carry raw binary (the file bytes); handled before JSON parsing.
    if (req.method === 'POST' && url.pathname === '/api/extract') {
      await this.extract(req, url, res);
      return;
    }

    const body = await readJson(req).catch(() => undefined);

    if (req.method === 'POST' && url.pathname === '/api/voice/speak') {
      await this.speak(body, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat/stream') {
      await this.streamChat(body, res);
      return;
    }

    const result = await this.handler.handle({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  }

  /** Exchange the API key (body.key or Authorization/x-api-key header) for a session token. */
  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req).catch(() => undefined);
    const fromBody = typeof (body as { key?: unknown })?.key === 'string' ? (body as { key: string }).key : undefined;
    const key = fromBody ?? extractCredential(req.headers);
    const grant = this.opts.authenticator!.login(key);
    if (!grant) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid api key' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(grant));
  }

  private async transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const voice = this.opts.deps.voice;
    if (!voice) return notConfigured(res);
    const audio = await readRaw(req);
    const text = await voice.transcribe(audio, req.headers['content-type'] ?? 'audio/webm');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text }));
  }

  /** Extract text from an uploaded file (?name=<filename>, raw bytes in the body). */
  private async extract(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const filename = url.searchParams.get('name') ?? 'upload';
    const buffer = await readRaw(req, MAX_UPLOAD_BYTES);
    try {
      const result = await extractUpload({
        filename,
        buffer,
        ...(this.opts.deps.vision ? { vision: this.opts.deps.vision } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async speak(body: unknown, res: ServerResponse): Promise<void> {
    const voice = this.opts.deps.voice;
    if (!voice) return notConfigured(res);
    const parsed = parseBody(speakSchema, body);
    if (!parsed.ok) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: parsed.error }));
      return;
    }
    const { audio, mimeType } = await voice.synthesize(parsed.data.text);
    res.writeHead(200, { 'content-type': mimeType });
    res.end(audio);
  }

  private async streamChat(body: unknown, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const parsed = parseBody(chatSchema, body);
    if (!parsed.ok) {
      send('error', { error: parsed.error });
      res.end();
      return;
    }
    const { text, mode, history } = parsed.data;

    send('start', { text, mode: mode ?? 'general' });
    const liveEvents: unknown[] = [];
    const result = await this.opts.deps.agent.run(
      { text, source: 'user', ...(mode ? { mode } : {}), ...(history ? { history } : {}) },
      controller.signal,
      {
        onText: (token) => send('token', { token }),
        onAudit: (event) => {
          liveEvents.push(event);
          send('activity', { events: liveEvents });
        },
      },
    );
    if (controller.signal.aborted) return;
    send('done', {
      runId: result.runId,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
    });
    res.end();
  }

  private allowedOrigins(): string[] {
    return this.opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  }

  private requestFailed(error: unknown, res: ServerResponse): void {
    const message = error instanceof Error ? error.message : String(error);
    this.opts.logger.error('api request failed', { error: message });
    if (res.writableEnded) return;
    if (res.headersSent) {
      if (res.getHeader('content-type') === 'text/event-stream') {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'request failed' })}\n\n`);
      }
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream provider failed' }));
  }
}

function cors(res: ServerResponse, origin: string | undefined): void {
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-api-key');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function notConfigured(res: ServerResponse): void {
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'voice provider not configured' }));
}

async function readRaw(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST' && req.method !== 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}
