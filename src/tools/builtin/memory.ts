import { z } from 'zod';
import type { StructuredStore } from '../../memory/stores.js';
import { STRUCTURED_KINDS } from '../../memory/types.js';
import type { Tool } from '../../types.js';
import { defineTool } from '../define.js';

export function createMemoryTools(store: StructuredStore): Tool[] {
  const searchMemory = defineTool({
    name: 'search_memory',
    description: 'Search the principal user\'s explicit structured memory. Use when asked what ARES remembers or before forgetting a fact.',
    kind: 'read_only',
    schema: z.object({
      query: z.string().describe('Words describing the person, project, preference, fact, or decision to find.'),
    }),
    async execute(input) {
      const facts = await store.search(input.query, 10);
      return {
        ok: true,
        content: facts.length
          ? JSON.stringify(facts.map(({ id, kind, subject, content }) => ({ id, kind, subject, content })))
          : 'No matching structured memory was found.',
        data: { count: facts.length },
      };
    },
  });

  const rememberMemory = defineTool({
    name: 'remember_memory',
    description: 'Store an explicit durable fact, project, preference, person, or decision after the user asks ARES to remember it.',
    kind: 'state_mutating',
    schema: z.object({
      kind: z.enum(STRUCTURED_KINDS),
      subject: z.string().describe('The person, project, company, or topic this memory is about.'),
      content: z.string().describe('A concise canonical statement to remember.'),
      importance: z.number().min(0).max(1).optional(),
    }),
    async execute(input, ctx) {
      const fact = await store.upsert({
        kind: input.kind,
        subject: input.subject,
        content: input.content,
        importance: input.importance ?? 0.8,
        confidence: 1,
        attributes: { explicit: true },
        sourceRun: ctx.runId,
      });
      return {
        ok: true,
        content: `Remembered ${fact.kind} "${fact.subject}": ${fact.content}`,
        data: { id: fact.id },
      };
    },
  });

  const forgetMemory = defineTool({
    name: 'forget_memory',
    description: 'Forget one explicit structured memory by id. Call search_memory first to identify the exact fact. This is gated and never deletes audit history.',
    kind: 'state_mutating',
    schema: z.object({
      id: z.string().describe('Exact structured memory id returned by search_memory.'),
    }),
    async execute(input) {
      const removed = await store.remove(input.id);
      return removed
        ? { ok: true, content: `Forgot structured memory ${input.id}.` }
        : { ok: false, content: `No active structured memory exists with id ${input.id}.` };
    },
  });

  return [searchMemory, rememberMemory, forgetMemory];
}
