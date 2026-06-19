import type { MemoryItem, MemoryStore } from './MemoryStore.js';

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  async retrieve(query: string, limit = 10): Promise<MemoryItem[]> {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return (await this.store.list())
      .map((item) => ({ item, score: terms.filter((term) => `${item.subject} ${item.content}`.toLowerCase().includes(term)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);
  }
}
