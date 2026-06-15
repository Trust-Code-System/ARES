/**
 * Store contracts + in-memory implementations.
 *
 * The retriever, ingestor, and consolidation job depend only on these
 * interfaces. Two implementations exist:
 *   - InMemory* here — the zero-config fallback (no Supabase) and the test double.
 *   - Pg* in pgStores.ts — the durable path that satisfies the "persist to a DB,
 *     never flat files" principle.
 *
 * The in-memory stores are a development convenience; they are NOT a persistence
 * layer (state dies with the process). ARES logs loudly when it falls back to
 * them so it's never mistaken for real memory.
 */

import { randomUUID } from 'node:crypto';
import type {
  NewMemoryChunk,
  NewStructuredFact,
  SemanticHit,
  StructuredFact,
  StructuredKind,
} from './types.js';
import { dedupeKey } from './types.js';

export interface SemanticStore {
  /** Persist embedded chunks. `embeddings[i]` corresponds to `chunks[i]`. */
  add(chunks: NewMemoryChunk[], embeddings: number[][]): Promise<void>;
  /** Top-k chunks by cosine similarity to `queryEmbedding`, above `minSimilarity`. */
  search(
    queryEmbedding: number[],
    k: number,
    minSimilarity?: number,
  ): Promise<SemanticHit[]>;
}

export interface StructuredStore {
  /** Idempotent upsert keyed by (kind, subject, content). Returns the persisted row. */
  upsert(fact: NewStructuredFact): Promise<StructuredFact>;
  /** Facts whose subject/content match the query text, most important first. */
  search(query: string, k: number, kinds?: StructuredKind[]): Promise<StructuredFact[]>;
  /** All live (non-superseded) facts, for consolidation. */
  all(): Promise<StructuredFact[]>;
  /** Forget a fact by id. Durable stores tombstone rather than hard-delete it. */
  remove(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

interface StoredChunk extends NewMemoryChunk {
  id: string;
  embedding: number[];
  createdAt: string;
}

export class InMemorySemanticStore implements SemanticStore {
  private readonly chunks: StoredChunk[] = [];

  async add(chunks: NewMemoryChunk[], embeddings: number[][]): Promise<void> {
    chunks.forEach((c, i) => {
      this.chunks.push({
        ...c,
        id: randomUUID(),
        embedding: embeddings[i] ?? [],
        createdAt: new Date().toISOString(),
      });
    });
  }

  async search(
    queryEmbedding: number[],
    k: number,
    minSimilarity = 0,
  ): Promise<SemanticHit[]> {
    return this.chunks
      .map((c) => ({ c, similarity: cosine(queryEmbedding, c.embedding) }))
      .filter(({ similarity }) => similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .map(({ c, similarity }) => ({
        id: c.id,
        sourceType: c.sourceType,
        sourceRef: c.sourceRef ?? null,
        content: c.content,
        metadata: c.metadata ?? {},
        importance: c.importance ?? 0.5,
        createdAt: c.createdAt,
        similarity,
      }));
  }
}

export class InMemoryStructuredStore implements StructuredStore {
  private readonly byKey = new Map<string, StructuredFact>();

  async upsert(fact: NewStructuredFact): Promise<StructuredFact> {
    const key = dedupeKey(fact.kind, fact.subject, fact.content);
    const now = new Date().toISOString();
    const existing = this.byKey.get(key);
    const row: StructuredFact = {
      id: existing?.id ?? randomUUID(),
      kind: fact.kind,
      subject: fact.subject,
      content: fact.content,
      attributes: fact.attributes ?? {},
      confidence: fact.confidence ?? 1,
      importance: fact.importance ?? 0.5,
      sourceRun: fact.sourceRun ?? existing?.sourceRun ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byKey.set(key, row);
    return row;
  }

  async search(query: string, k: number, kinds?: StructuredKind[]): Promise<StructuredFact[]> {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return [...this.byKey.values()]
      .filter((f) => !kinds || kinds.includes(f.kind))
      .map((f) => ({ f, score: lexicalScore(terms, `${f.subject} ${f.content}`) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.f.importance - a.f.importance)
      .slice(0, k)
      .map(({ f }) => f);
  }

  async all(): Promise<StructuredFact[]> {
    return [...this.byKey.values()];
  }

  async remove(id: string): Promise<boolean> {
    const entry = [...this.byKey.entries()].find(([, fact]) => fact.id === id);
    if (!entry) return false;
    return this.byKey.delete(entry[0]);
  }
}

export function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function lexicalScore(terms: string[], text: string): number {
  const hay = text.toLowerCase();
  return terms.reduce((s, t) => (hay.includes(t) ? s + 1 : s), 0);
}
