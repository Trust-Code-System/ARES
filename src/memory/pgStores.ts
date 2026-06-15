/**
 * Postgres-backed memory stores — the durable path.
 *
 * Thin SQL over the schema in migrations/0001. Vector search uses the cosine
 * distance operator `<=>`; we return similarity as `1 - distance` so callers
 * reason in "higher is closer" terms. These can't be meaningfully unit-tested
 * without a live database, so they stay deliberately thin and the logic that
 * matters (ranking, dedupe normalization, formatting) lives in testable code.
 */

import type { Db } from '../db/client.js';
import { toVectorLiteral } from '../db/client.js';
import type { SemanticStore, StructuredStore } from './stores.js';
import type {
  NewMemoryChunk,
  NewStructuredFact,
  SemanticHit,
  StructuredFact,
  StructuredKind,
} from './types.js';
import { dedupeKey } from './types.js';

export class PgSemanticStore implements SemanticStore {
  constructor(private readonly db: Db) {}

  async add(chunks: NewMemoryChunk[], embeddings: number[][]): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      await this.db.query(
        `insert into semantic_memory (source_type, source_ref, content, embedding, metadata, importance)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          c.sourceType,
          c.sourceRef ?? null,
          c.content,
          toVectorLiteral(embeddings[i] ?? []),
          JSON.stringify(c.metadata ?? {}),
          c.importance ?? 0.5,
        ],
      );
    }
  }

  async search(
    queryEmbedding: number[],
    k: number,
    minSimilarity = 0,
  ): Promise<SemanticHit[]> {
    const res = await this.db.query<{
      id: string;
      source_type: SemanticHit['sourceType'];
      source_ref: string | null;
      content: string;
      metadata: Record<string, unknown>;
      importance: number;
      created_at: string;
      similarity: number;
    }>(
      `select id, source_type, source_ref, content, metadata, importance, created_at,
              1 - (embedding <=> $1) as similarity
         from semantic_memory
        where superseded_at is null
          and 1 - (embedding <=> $1) >= $3
        order by embedding <=> $1
        limit $2`,
      [toVectorLiteral(queryEmbedding), k, minSimilarity],
    );

    return res.rows.map((r) => ({
      id: r.id,
      sourceType: r.source_type,
      sourceRef: r.source_ref,
      content: r.content,
      metadata: r.metadata ?? {},
      importance: r.importance,
      createdAt: new Date(r.created_at).toISOString(),
      similarity: r.similarity,
    }));
  }
}

export class PgStructuredStore implements StructuredStore {
  constructor(private readonly db: Db) {}

  async upsert(fact: NewStructuredFact): Promise<StructuredFact> {
    const key = dedupeKey(fact.kind, fact.subject, fact.content);
    const res = await this.db.query<StructuredRow>(
      `insert into structured_memory
         (kind, subject, content, attributes, confidence, importance, source_run, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (dedupe_key) do update set
         attributes = excluded.attributes,
         confidence = greatest(structured_memory.confidence, excluded.confidence),
         importance = greatest(structured_memory.importance, excluded.importance),
         updated_at = now(),
         superseded_at = null
       returning *`,
      [
        fact.kind,
        fact.subject,
        fact.content,
        JSON.stringify(fact.attributes ?? {}),
        fact.confidence ?? 1,
        fact.importance ?? 0.5,
        fact.sourceRun ?? null,
        key,
      ],
    );
    return rowToFact(res.rows[0]!);
  }

  async search(query: string, k: number, kinds?: StructuredKind[]): Promise<StructuredFact[]> {
    const res = await this.db.query<StructuredRow>(
      `select * from structured_memory
        where superseded_at is null
          and ($3::text[] is null or kind = any($3))
          and to_tsvector('english', subject || ' ' || content) @@ plainto_tsquery('english', $1)
        order by ts_rank(to_tsvector('english', subject || ' ' || content),
                         plainto_tsquery('english', $1)) desc,
                 importance desc
        limit $2`,
      [query, k, kinds ?? null],
    );
    return res.rows.map(rowToFact);
  }

  async all(): Promise<StructuredFact[]> {
    const res = await this.db.query<StructuredRow>(
      `select * from structured_memory where superseded_at is null order by updated_at desc`,
    );
    return res.rows.map(rowToFact);
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.db.query(
      `update structured_memory
          set superseded_at = now(), updated_at = now()
        where id = $1 and superseded_at is null
        returning id`,
      [id],
    );
    return res.rows.length > 0;
  }
}

interface StructuredRow {
  id: string;
  kind: StructuredKind;
  subject: string;
  content: string;
  attributes: Record<string, unknown>;
  confidence: number;
  importance: number;
  source_run: string | null;
  created_at: string;
  updated_at: string;
}

function rowToFact(r: StructuredRow): StructuredFact {
  return {
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    content: r.content,
    attributes: r.attributes ?? {},
    confidence: r.confidence,
    importance: r.importance,
    sourceRun: r.source_run,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
