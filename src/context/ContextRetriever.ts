import type { ContextSource } from './ContextPack.js';

export class ContextRetriever {
  constructor(private readonly sources: readonly ContextSource[] = []) {}

  retrieve(query: string, limit = 8): ContextSource[] {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return this.sources
      .map((source) => ({ source, score: terms.filter((term) => `${source.title} ${source.content}`.toLowerCase().includes(term)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ source }) => source);
  }
}
