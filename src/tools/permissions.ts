/**
 * Durable tool permissions.
 *
 * The {@link ToolRegistry} is a pure in-memory catalog: its enable/disable
 * toggles don't survive a restart, so a deliberately disabled (e.g. risky) tool
 * would silently come back enabled. This store persists the overrides. The
 * registry stays storage-agnostic — the composition root loads the disabled set
 * at startup and applies it, and the API persists each toggle through this store.
 *
 * A row exists only for a tool whose state was explicitly changed; absence means
 * the default (enabled).
 */

import type { Db } from '../db/client.js';

export interface ToolPermissionStore {
  /** Names of tools currently disabled by an operator. */
  disabledTools(): Promise<string[]>;
  /** Persist a tool's enabled state. `by` records who changed it. */
  setEnabled(tool: string, enabled: boolean, by?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory (no-DB fallback / tests)
// ---------------------------------------------------------------------------

export class InMemoryToolPermissionStore implements ToolPermissionStore {
  private readonly state = new Map<string, boolean>();

  async disabledTools(): Promise<string[]> {
    return [...this.state.entries()].filter(([, enabled]) => !enabled).map(([tool]) => tool);
  }

  async setEnabled(tool: string, enabled: boolean): Promise<void> {
    this.state.set(tool, enabled);
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export class PgToolPermissionStore implements ToolPermissionStore {
  constructor(private readonly db: Db) {}

  async disabledTools(): Promise<string[]> {
    const res = await this.db.query<{ tool: string }>(
      `select tool from tool_permissions where enabled = false`,
    );
    return res.rows.map((r) => r.tool);
  }

  async setEnabled(tool: string, enabled: boolean, by = 'ui'): Promise<void> {
    await this.db.query(
      `insert into tool_permissions (tool, enabled, changed_at, changed_by)
       values ($1, $2, now(), $3)
       on conflict (tool) do update
         set enabled = excluded.enabled, changed_at = now(), changed_by = excluded.changed_by`,
      [tool, enabled, by],
    );
  }
}

export function buildToolPermissionStore(db: Db | undefined): ToolPermissionStore {
  return db ? new PgToolPermissionStore(db) : new InMemoryToolPermissionStore();
}
