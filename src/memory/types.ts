/**
 * Memory domain types — the vocabulary shared by the stores, the retriever, the
 * ingestor, and the consolidation job.
 *
 * Two stores, two shapes:
 *   - structured_memory → {@link StructuredFact}: typed, deduped, queryable facts.
 *   - semantic_memory   → {@link MemoryChunk}: embedded free text, retrieved by
 *     vector similarity.
 */

/** The five kinds of structured fact ARES keeps about the user's world. */
export type StructuredKind = 'fact' | 'person' | 'project' | 'preference' | 'decision';

export const STRUCTURED_KINDS: readonly StructuredKind[] = [
  'fact',
  'person',
  'project',
  'preference',
  'decision',
] as const;

/** A typed structured fact as written by the ingestor (pre-persistence). */
export interface NewStructuredFact {
  kind: StructuredKind;
  /** The entity/topic this is about (e.g. a person's name, a project, "user"). */
  subject: string;
  /** Canonical human-readable statement. */
  content: string;
  /** Kind-specific structured fields (free-form, validated by the writer). */
  attributes?: Record<string, unknown>;
  /** Model's confidence the fact is true, 0..1. */
  confidence?: number;
  /** How much this should be weighted in retrieval, 0..1. */
  importance?: number;
  /** Run that produced it, for provenance. */
  sourceRun?: string;
}

/** A persisted structured fact. */
export interface StructuredFact extends Required<Omit<NewStructuredFact, 'sourceRun'>> {
  id: string;
  sourceRun: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Source category for a semantic chunk. */
export type ChunkSource = 'conversation' | 'document' | 'event' | 'summary';

/** A chunk of text to embed and store (pre-persistence). */
export interface NewMemoryChunk {
  sourceType: ChunkSource;
  sourceRef?: string;
  content: string;
  metadata?: Record<string, unknown>;
  importance?: number;
}

/** A semantic search hit: the stored chunk plus its similarity to the query. */
export interface SemanticHit {
  id: string;
  sourceType: ChunkSource;
  sourceRef: string | null;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  createdAt: string;
  /** Cosine similarity in [0,1]; higher is closer. */
  similarity: number;
}

/** Normalized key used to make repeated ingestion of the same fact idempotent. */
export function dedupeKey(kind: StructuredKind, subject: string, content: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${kind}:${norm(subject)}:${norm(content)}`;
}
