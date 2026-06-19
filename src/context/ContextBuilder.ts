import { ContextCompressor } from './ContextCompressor.js';
import type { ContextPack, ContextSource } from './ContextPack.js';

export class ContextBuilder {
  constructor(private readonly compressor = new ContextCompressor()) {}

  build(request: string, sources: readonly ContextSource[], tokenBudget?: number): ContextPack {
    const maxChars = tokenBudget ? Math.max(1000, tokenBudget * 4) : 24000;
    let used = 0;
    const selected: ContextSource[] = [];
    const warnings: string[] = [];
    for (const source of sources) {
      if (used >= maxChars) {
        warnings.push(`Skipped ${source.title}: context budget exhausted`);
        continue;
      }
      const content = this.compressor.compress(source.content, Math.min(4000, maxChars - used));
      used += content.length;
      selected.push({ ...source, content });
    }
    return { request, sources: selected, ...(tokenBudget ? { tokenBudget } : {}), warnings };
  }
}
