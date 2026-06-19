import type { ContextSource } from './ContextPack.js';

export class SourceTracker {
  private readonly sources = new Map<string, ContextSource>();

  add(source: ContextSource): void {
    this.sources.set(source.id, source);
  }

  list(): ContextSource[] {
    return [...this.sources.values()];
  }
}
