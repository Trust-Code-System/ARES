import type { ContextSource } from './ContextPack.js';

export interface ResearchLoopResult {
  question: string;
  sources: ContextSource[];
  conflicts: string[];
  staleWarnings: string[];
}

export class ResearchLoop {
  summarize(question: string, sources: readonly ContextSource[]): ResearchLoopResult {
    return {
      question,
      sources: [...sources],
      conflicts: [],
      staleWarnings: sources.filter((s) => isStale(s.createdAt)).map((s) => `${s.title} may be stale`),
    };
  }
}

function isStale(date: string | undefined): boolean {
  if (!date) return false;
  const then = Date.parse(date);
  return Number.isFinite(then) && Date.now() - then > 1000 * 60 * 60 * 24 * 180;
}
