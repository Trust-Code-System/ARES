import type { AgentPersona } from './AgentPersona.js';

export class AgentRegistry {
  private readonly personas = new Map<string, AgentPersona>();

  register(id: string, persona: AgentPersona): void {
    this.personas.set(id, persona);
  }

  get(id: string): AgentPersona | undefined {
    return this.personas.get(id);
  }

  list(): Array<{ id: string; persona: AgentPersona }> {
    return [...this.personas.entries()].map(([id, persona]) => ({ id, persona }));
  }
}
