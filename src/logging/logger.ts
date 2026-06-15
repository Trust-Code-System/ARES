/**
 * Logging and audit.
 *
 * Two distinct concerns live here:
 *   - {@link ConsoleLogger}: developer-facing, transient, pretty terminal output.
 *   - {@link InMemoryAuditLog}: the immutable record of every decision and action.
 *
 * The audit log is a CORE PRINCIPLE, not a debug aid. In Phase 2 the in-memory
 * implementation is replaced by an append-only Postgres table; nothing in the
 * orchestrator changes because it only ever sees the {@link AuditLog} interface.
 */

import type { AuditEvent, AuditLog, Logger, LogLevel } from '../types.js';

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // grey
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  private readonly order: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (this.order[level] < this.order[this.minLevel]) return;
    const tag = `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
    const time = new Date().toISOString().slice(11, 19);
    const suffix =
      meta && Object.keys(meta).length > 0 ? ` ${safeJson(meta)}` : '';
    // eslint-disable-next-line no-console
    console.log(`${time} ${tag} ${msg}${suffix}`);
  }

  debug = (m: string, meta?: Record<string, unknown>) => this.log('debug', m, meta);
  info = (m: string, meta?: Record<string, unknown>) => this.log('info', m, meta);
  warn = (m: string, meta?: Record<string, unknown>) => this.log('warn', m, meta);
  error = (m: string, meta?: Record<string, unknown>) => this.log('error', m, meta);
}

/**
 * Append-only, in-memory audit trail. Immutable from the caller's perspective:
 * `record` only appends, and `forRun` returns copies.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly mirror?: Logger) {}

  record(event: AuditEvent): void {
    const stored = structuredClone(event);
    this.events.push(stored);
    this.mirror?.debug(`audit:${stored.type}`, { runId: stored.runId, ...stored.detail });
  }

  forRun(runId: string): AuditEvent[] {
    return structuredClone(this.events.filter((event) => event.runId === runId));
  }

  all(): AuditEvent[] {
    return structuredClone(this.events);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
