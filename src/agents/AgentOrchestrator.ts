import type { AgentPersona } from './AgentPersona.js';
import { AgentRegistry } from './AgentRegistry.js';

export interface AgentSelection {
  id: string;
  persona: AgentPersona;
  reason: string;
}

export class AgentOrchestrator {
  constructor(private readonly registry: AgentRegistry) {}

  select(task: string, limit = 3): AgentSelection[] {
    const terms = task.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return this.registry.list()
      .map(({ id, persona }) => ({
        id,
        persona,
        score: terms.filter((term) => `${persona.role} ${persona.expertise.join(' ')} ${persona.when_to_use.join(' ')}`.toLowerCase().includes(term)).length,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ id, persona }) => ({ id, persona, reason: `Matched ${persona.role} to task terms` }));
  }
}
