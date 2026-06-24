/**
 * Dynamic voice vocabulary drawn from the user's own world.
 *
 * The static list in voice.ts covers generic AI/tech terms, but it can't know the
 * proper nouns specific to one principal — the people and projects in their memory,
 * or the connectors they've wired up. Those are exactly the names a general STT
 * model has no chance of spelling ("Petrobrain", a colleague's surname). This
 * source surfaces them so the transcriber biases toward them too.
 *
 * It's awaited on every transcription, so results are cached with a short TTL to
 * keep memory reads off the hot path.
 */

import type { StructuredStore } from '../memory/stores.js';
import type { StructuredFact } from '../memory/types.js';
import type { VocabularySource } from './voice.js';

export interface MemoryVocabularyOptions {
  /** How long to cache the extracted terms before re-reading memory. Default 5 min. */
  ttlMs?: number;
  /** Max terms to surface (the merge step caps the total again). Default 48. */
  limit?: number;
}

/**
 * Build a {@link VocabularySource} from structured memory: the names (subjects) of
 * `person` and `project` facts — the user's people and projects. Cached for `ttlMs`.
 */
export function memoryVocabularySource(
  store: StructuredStore,
  opts: MemoryVocabularyOptions = {},
): VocabularySource {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const limit = opts.limit ?? 48;
  let cache: { at: number; terms: string[] } | undefined;

  return async () => {
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) return cache.terms;
    const facts = await store.all();
    const terms = properNounsFromFacts(facts, limit);
    cache = { at: now, terms };
    return terms;
  };
}

/** Pull deduped name-like subjects from person/project facts. */
function properNounsFromFacts(facts: StructuredFact[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fact of facts) {
    if (fact.kind !== 'person' && fact.kind !== 'project') continue;
    const subject = fact.subject.trim();
    // Skip empties, over-long phrases (not names), generic placeholders, and
    // anything with no letters.
    if (!subject || subject.length > 40) continue;
    if (!/[A-Za-z]/.test(subject)) continue;
    if (subject.toLowerCase() === 'user') continue;
    const key = subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(subject);
    if (out.length >= limit) break;
  }
  return out;
}
