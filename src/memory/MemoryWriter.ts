import type { MemoryItem, MemoryStore } from './MemoryStore.js';
import type { MemoryType } from './MemoryPolicy.js';

export class MemoryWriter {
  constructor(private readonly store: MemoryStore) {}

  async save(type: MemoryType, subject: string, content: string): Promise<MemoryItem> {
    return this.store.write({ type, subject, content });
  }
}
