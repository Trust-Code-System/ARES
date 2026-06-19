/**
 * Memory retrieval — the "retrieve context before reasoning" step of the loop.
 *
 * {@link DbMemoryRetriever} embeds the incoming query, pulls the top-k semantic
 * chunks (pgvector) and the most relevant structured facts (Postgres), and folds
 * them into a single context block the orchestrator injects into the system
 * prompt. {@link NullMemoryRetriever} is the Phase-1 no-op, kept as the fallback
 * when no memory backend is configured.
 */

import type { MemoryRetriever } from '../types.js';
import type { EmbeddingClient } from './embeddings.js';
import type { SemanticStore, StructuredStore } from './stores.js';
import type { StructuredFact } from './types.js';
import { redactSensitiveText } from '../security/redactor.js';

export class NullMemoryRetriever implements MemoryRetriever {
  async retrieve(): Promise<string> {
    return '';
  }
}

export interface DbRetrieverOptions {
  semantic: SemanticStore;
  structured: StructuredStore;
  embeddings: EmbeddingClient;
  /** How many semantic chunks to pull. Default 6. */
  semanticTopK?: number;
  /** How many structured facts to pull. Default 8. */
  structuredTopK?: number;
  /** Drop semantic hits below this cosine similarity. Default 0.3. */
  minSimilarity?: number;
}

export class DbMemoryRetriever implements MemoryRetriever {
  private readonly semanticTopK: number;
  private readonly structuredTopK: number;
  private readonly minSimilarity: number;

  constructor(private readonly opts: DbRetrieverOptions) {
    this.semanticTopK = opts.semanticTopK ?? 6;
    this.structuredTopK = opts.structuredTopK ?? 8;
    this.minSimilarity = opts.minSimilarity ?? 0.3;
  }

  async retrieve(query: string): Promise<string> {
    const safeQuery = redactSensitiveText(query);
    const [queryEmbedding] = await this.opts.embeddings.embed([safeQuery], 'query');

    const [facts, hits] = await Promise.all([
      this.opts.structured.search(safeQuery, this.structuredTopK),
      queryEmbedding
        ? this.opts.semantic.search(queryEmbedding, this.semanticTopK, this.minSimilarity)
        : Promise.resolve([]),
    ]);

    const sections: string[] = [];

    if (facts.length) {
      sections.push(
        ['### Known facts', ...facts.map(formatFact)].join('\n'),
      );
    }

    if (hits.length) {
      sections.push(
        [
          '### Relevant past context',
          ...hits.map((h) => `- (${h.sourceType}, ${(h.similarity * 100).toFixed(0)}% match) ${oneLine(h.content)}`),
        ].join('\n'),
      );
    }

    return sections.join('\n\n');
  }
}

function formatFact(f: StructuredFact): string {
  const conf = f.confidence < 0.75 ? ` _(confidence ${(f.confidence * 100).toFixed(0)}%)_` : '';
  return redactSensitiveText(`- [${f.kind}] ${f.subject}: ${f.content}${conf}`);
}

function oneLine(text: string, max = 240): string {
  const flat = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
