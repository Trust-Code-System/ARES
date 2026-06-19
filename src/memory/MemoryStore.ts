import { randomUUID } from 'node:crypto';
import { MemoryPolicy, type MemoryType } from './MemoryPolicy.js';
import { MemoryRedactor } from './MemoryRedactor.js';

export interface MemoryItem {
  id: string;
  type: MemoryType;
  subject: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  private readonly items = new Map<string, MemoryItem>();

  constructor(private readonly policy = new MemoryPolicy(), private readonly redactor = new MemoryRedactor()) {}

  async write(input: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryItem> {
    const decision = this.policy.evaluate(input, input.type);
    if (!decision.allowed) throw new Error(decision.reason ?? 'memory write denied');
    const now = new Date().toISOString();
    const item: MemoryItem = {
      id: randomUUID(),
      type: input.type,
      subject: this.redactor.redactText(input.subject),
      content: this.redactor.redactText(input.content),
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    return item;
  }

  async list(): Promise<MemoryItem[]> {
    return [...this.items.values()];
  }

  async forget(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}
