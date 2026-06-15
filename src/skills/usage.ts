/**
 * Skill-usage memory (Phase 5 — the "skill memory" tier).
 *
 * Records which skills were loaded (via `use_skill`) and when, so the system can
 * answer "what expertise have I been leaning on" and, later, bias routing toward
 * skills that have worked. Deliberately small: an interface plus an in-memory
 * implementation. Persistence (Postgres) is a follow-up — the in-memory store
 * resets per process, matching how other ARES backends degrade without a DB.
 */

export interface SkillUseRecord {
  skillId: string;
  /** Audit run the use belonged to, when known. */
  runId?: string;
  /** Epoch ms. */
  at: number;
}

export interface SkillUsageStore {
  /** Record one successful skill load. Never throws (best-effort telemetry). */
  record(skillId: string, runId?: string): void;
  /** Most recent uses, newest first. */
  recent(limit?: number): SkillUseRecord[];
  /** Skills ordered by use count, most used first. */
  topUsed(limit?: number): Array<{ skillId: string; count: number; lastAt: number }>;
}

export class InMemorySkillUsageStore implements SkillUsageStore {
  private readonly log: SkillUseRecord[] = [];
  private readonly counts = new Map<string, { count: number; lastAt: number }>();
  /** Cap the in-memory log so a long-lived process can't grow unbounded. */
  constructor(private readonly maxLog = 1000) {}

  record(skillId: string, runId?: string): void {
    const at = Date.now();
    this.log.push(runId !== undefined ? { skillId, runId, at } : { skillId, at });
    if (this.log.length > this.maxLog) this.log.shift();
    const cur = this.counts.get(skillId);
    if (cur) {
      cur.count++;
      cur.lastAt = at;
    } else {
      this.counts.set(skillId, { count: 1, lastAt: at });
    }
  }

  recent(limit = 20): SkillUseRecord[] {
    return this.log.slice(-limit).reverse();
  }

  topUsed(limit = 10): Array<{ skillId: string; count: number; lastAt: number }> {
    return [...this.counts.entries()]
      .map(([skillId, v]) => ({ skillId, ...v }))
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, limit);
  }
}
