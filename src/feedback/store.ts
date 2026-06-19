/**
 * Feedback store — the principal's signal on what ARES did, and the pairwise
 * preference data distilled from it.
 *
 * This is the foundation of the ARES improvement loop (see
 * docs/github-extraction-report.md, repos #1/#2): capture thumbs/ratings/
 * corrections, turn explicit choices and corrections into {prompt, chosen,
 * rejected} preference pairs, and hand those to the training pipeline's DPO
 * export. Nothing here trains anything — it only *collects*. Sanitization /
 * consent gating happens at export time in src/ai-training.
 *
 * Same shape as the other stores (see src/tasks/store.ts): an interface with an
 * in-memory fallback and a Postgres implementation (schema in migrations/0006),
 * plus a `build*` helper.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';

export const FEEDBACK_TARGETS = ['response', 'action', 'summary', 'other'] as const;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

/** -1 = thumbs down, 0 = neutral/comment, +1 = thumbs up. */
export type FeedbackRating = -1 | 0 | 1;

export const PREFERENCE_SOURCES = [
  'manual',
  'correction',
  'ab_choice',
  'action_ranking',
  'imported',
] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

export const SAFETY_LABELS = ['safe', 'unsafe_rejected', 'privacy'] as const;
export type SafetyLabel = (typeof SAFETY_LABELS)[number];

export interface Feedback {
  id: string;
  runId: string | null;
  target: FeedbackTarget;
  rating: FeedbackRating;
  note: string;
  correction: string | null;
  prompt: string | null;
  response: string | null;
  createdAt: string;
}

export interface NewFeedback {
  runId?: string | null;
  target?: FeedbackTarget;
  rating?: FeedbackRating;
  note?: string;
  correction?: string | null;
  prompt?: string | null;
  response?: string | null;
}

export interface PreferencePair {
  id: string;
  prompt: string;
  chosen: string;
  rejected: string;
  reason: string;
  source: PreferenceSource;
  safetyLabel: SafetyLabel | null;
  createdAt: string;
}

export interface NewPreferencePair {
  prompt: string;
  chosen: string;
  rejected: string;
  reason?: string;
  source?: PreferenceSource;
  safetyLabel?: SafetyLabel | null;
}

export interface FeedbackStore {
  /** Record a raw feedback signal. */
  record(feedback: NewFeedback): Promise<Feedback>;
  /** Feedback, newest first. */
  list(filter?: { rating?: FeedbackRating; limit?: number }): Promise<Feedback[]>;
  /** Store a preference pair. A correction implicitly creates one (chosen=correction). */
  addPreference(pair: NewPreferencePair): Promise<PreferencePair>;
  /** Preference pairs, newest first. Filter by source for export. */
  listPreferences(filter?: { source?: PreferenceSource; limit?: number }): Promise<PreferencePair[]>;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly feedback = new Map<string, Feedback>();
  private readonly preferences = new Map<string, PreferencePair>();

  async record(feedback: NewFeedback): Promise<Feedback> {
    const row: Feedback = {
      id: randomUUID(),
      runId: feedback.runId ?? null,
      target: feedback.target ?? 'response',
      rating: feedback.rating ?? 0,
      note: feedback.note ?? '',
      correction: feedback.correction ?? null,
      prompt: feedback.prompt ?? null,
      response: feedback.response ?? null,
      createdAt: new Date().toISOString(),
    };
    this.feedback.set(row.id, row);
    return { ...row };
  }

  async list(filter?: { rating?: FeedbackRating; limit?: number }): Promise<Feedback[]> {
    // Newest first by insertion order (Map preserves it) — deterministic even when
    // two rows share a millisecond, which a createdAt string-sort would not be.
    const all = [...this.feedback.values()]
      .reverse()
      .filter((f) => filter?.rating === undefined || f.rating === filter.rating);
    return (filter?.limit ? all.slice(0, filter.limit) : all).map((f) => ({ ...f }));
  }

  async addPreference(pair: NewPreferencePair): Promise<PreferencePair> {
    const row: PreferencePair = {
      id: randomUUID(),
      prompt: pair.prompt,
      chosen: pair.chosen,
      rejected: pair.rejected,
      reason: pair.reason ?? '',
      source: pair.source ?? 'manual',
      safetyLabel: pair.safetyLabel ?? null,
      createdAt: new Date().toISOString(),
    };
    this.preferences.set(row.id, row);
    return { ...row };
  }

  async listPreferences(filter?: { source?: PreferenceSource; limit?: number }): Promise<PreferencePair[]> {
    const all = [...this.preferences.values()]
      .reverse()
      .filter((p) => !filter?.source || p.source === filter.source);
    return (filter?.limit ? all.slice(0, filter.limit) : all).map((p) => ({ ...p }));
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface FeedbackRow {
  id: string;
  run_id: string | null;
  target: FeedbackTarget;
  rating: FeedbackRating;
  note: string;
  correction: string | null;
  prompt: string | null;
  response: string | null;
  created_at: string;
}

interface PreferenceRow {
  id: string;
  prompt: string;
  chosen: string;
  rejected: string;
  reason: string;
  source: PreferenceSource;
  safety_label: SafetyLabel | null;
  created_at: string;
}

export class PgFeedbackStore implements FeedbackStore {
  constructor(private readonly db: Db) {}

  async record(feedback: NewFeedback): Promise<Feedback> {
    const res = await this.db.query<FeedbackRow>(
      `insert into feedback (run_id, target, rating, note, correction, prompt, response)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        feedback.runId ?? null,
        feedback.target ?? 'response',
        feedback.rating ?? 0,
        feedback.note ?? '',
        feedback.correction ?? null,
        feedback.prompt ?? null,
        feedback.response ?? null,
      ],
    );
    return toFeedback(res.rows[0]!);
  }

  async list(filter?: { rating?: FeedbackRating; limit?: number }): Promise<Feedback[]> {
    const limit = filter?.limit ?? 200;
    if (filter?.rating !== undefined) {
      const res = await this.db.query<FeedbackRow>(
        `select * from feedback where rating = $1 order by created_at desc limit $2`,
        [filter.rating, limit],
      );
      return res.rows.map(toFeedback);
    }
    const res = await this.db.query<FeedbackRow>(
      `select * from feedback order by created_at desc limit $1`,
      [limit],
    );
    return res.rows.map(toFeedback);
  }

  async addPreference(pair: NewPreferencePair): Promise<PreferencePair> {
    const res = await this.db.query<PreferenceRow>(
      `insert into preference_pairs (prompt, chosen, rejected, reason, source, safety_label)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [
        pair.prompt,
        pair.chosen,
        pair.rejected,
        pair.reason ?? '',
        pair.source ?? 'manual',
        pair.safetyLabel ?? null,
      ],
    );
    return toPreference(res.rows[0]!);
  }

  async listPreferences(filter?: { source?: PreferenceSource; limit?: number }): Promise<PreferencePair[]> {
    const limit = filter?.limit ?? 500;
    if (filter?.source) {
      const res = await this.db.query<PreferenceRow>(
        `select * from preference_pairs where source = $1 order by created_at desc limit $2`,
        [filter.source, limit],
      );
      return res.rows.map(toPreference);
    }
    const res = await this.db.query<PreferenceRow>(
      `select * from preference_pairs order by created_at desc limit $1`,
      [limit],
    );
    return res.rows.map(toPreference);
  }
}

function toFeedback(r: FeedbackRow): Feedback {
  return {
    id: r.id,
    runId: r.run_id,
    target: r.target,
    rating: r.rating,
    note: r.note,
    correction: r.correction,
    prompt: r.prompt,
    response: r.response,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function toPreference(r: PreferenceRow): PreferencePair {
  return {
    id: r.id,
    prompt: r.prompt,
    chosen: r.chosen,
    rejected: r.rejected,
    reason: r.reason,
    source: r.source,
    safetyLabel: r.safety_label,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function buildFeedbackStore(db: Db | undefined): FeedbackStore {
  return db ? new PgFeedbackStore(db) : new InMemoryFeedbackStore();
}
