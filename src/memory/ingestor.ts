/**
 * Memory ingestion — "on every interaction: extract new facts, embed them, store them."
 *
 * After a run finishes, the orchestrator hands the exchange here. Two things happen:
 *   1. The exchange is chunked, embedded, and written to semantic_memory.
 *   2. The fast model is asked — with a *forced* tool call, so the output is
 *      schema-valid by construction — to extract durable structured facts, which
 *      are upserted (deduped) into structured_memory.
 *
 * Failures never propagate: a memory write going wrong must not fail the user's
 * turn. Errors are logged and swallowed. In Phase 4 this whole step moves onto a
 * BullMQ queue so it runs out of band instead of inline.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Logger, MemoryTurn, MemoryWriter } from '../types.js';
import type { MessageClient } from '../agent/orchestrator.js';
import type { EmbeddingClient } from './embeddings.js';
import type { SemanticStore, StructuredStore } from './stores.js';
import { STRUCTURED_KINDS, type NewMemoryChunk, type NewStructuredFact, type StructuredKind } from './types.js';

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_memory',
  description:
    'Record durable facts worth remembering about the user, the people, projects, ' +
    'preferences, and decisions in their world. Extract only stable, reusable ' +
    'information — not ephemeral chit-chat, task mechanics, or things ARES said.',
  input_schema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        description: 'Zero or more facts. Return an empty array if nothing is worth keeping.',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [...STRUCTURED_KINDS],
              description:
                'fact = general truth; person = someone in the user\'s life; ' +
                'project = ongoing work/goal; preference = how the user likes things; ' +
                'decision = a choice the user made.',
            },
            subject: {
              type: 'string',
              description: 'The entity/topic this is about (a name, a project, or "user").',
            },
            content: { type: 'string', description: 'One concise, self-contained statement.' },
            confidence: { type: 'number', description: '0..1 — how sure you are it is true.' },
            importance: { type: 'number', description: '0..1 — how useful to recall later.' },
          },
          required: ['kind', 'subject', 'content'],
          additionalProperties: false,
        },
      },
    },
    required: ['facts'],
    additionalProperties: false,
  },
};

const EXTRACTION_SYSTEM = `You extract durable memory from a single exchange between a user and ARES.
Call record_memory exactly once. Keep facts atomic and self-contained (resolve "I"/"my" to the user).
Skip anything transient, anything ARES merely did or said, and anything you are not reasonably confident about.`;

export interface IngestorOptions {
  client: MessageClient;
  embeddings: EmbeddingClient;
  semantic: SemanticStore;
  structured: StructuredStore;
  logger: Logger;
  /** Approx. max characters per embedded chunk. Default 1200. */
  chunkSize?: number;
}

export class MemoryIngestor implements MemoryWriter {
  private readonly chunkSize: number;

  constructor(private readonly opts: IngestorOptions) {
    this.chunkSize = opts.chunkSize ?? 1200;
  }

  async ingest(turn: MemoryTurn): Promise<void> {
    try {
      await Promise.all([this.embedExchange(turn), this.extractFacts(turn)]);
    } catch (err) {
      // Memory is best-effort relative to the user's turn — never fatal.
      this.opts.logger.error('memory ingestion failed', {
        runId: turn.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Chunk + embed the raw exchange into semantic_memory. */
  private async embedExchange(turn: MemoryTurn): Promise<void> {
    const text = `User: ${turn.userText}\n\nARES: ${turn.assistantText}`.trim();
    const pieces = chunkText(text, this.chunkSize);
    if (pieces.length === 0) return;

    const embeddings = await this.opts.embeddings.embed(pieces, 'document');
    const chunks: NewMemoryChunk[] = pieces.map((content) => ({
      sourceType: 'conversation',
      sourceRef: turn.runId,
      content,
      metadata: { source: turn.source },
    }));
    await this.opts.semantic.add(chunks, embeddings);
    this.opts.logger.debug('embedded exchange', { runId: turn.runId, chunks: chunks.length });
  }

  /** Force the fast model to emit structured facts, then upsert them. */
  private async extractFacts(turn: MemoryTurn): Promise<void> {
    const response = await this.opts.client.createMessage({
      tier: 'fast',
      system: EXTRACTION_SYSTEM,
      tools: [EXTRACTION_TOOL],
      toolChoice: { type: 'tool', name: EXTRACTION_TOOL.name },
      thinking: { type: 'disabled' },
      maxTokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Exchange to mine for durable memory:\n\nUser: ${turn.userText}\n\nARES: ${turn.assistantText}`,
        },
      ],
    });

    const facts = parseFacts(response.content);
    let stored = 0;
    for (const raw of facts) {
      const fact = normalizeFact(raw, turn.runId);
      if (!fact) continue;
      await this.opts.structured.upsert(fact);
      stored++;
    }
    this.opts.logger.debug('extracted facts', { runId: turn.runId, stored, seen: facts.length });
  }
}

/** Pull the forced tool call's `facts` array out of the response, defensively. */
function parseFacts(content: Anthropic.ContentBlock[]): unknown[] {
  const use = content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === EXTRACTION_TOOL.name,
  );
  const input = use?.input as { facts?: unknown } | undefined;
  return Array.isArray(input?.facts) ? input.facts : [];
}

/** Validate one raw extracted fact, returning null if it's unusable. */
function normalizeFact(raw: unknown, runId: string): NewStructuredFact | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
  const content = typeof r.content === 'string' ? r.content.trim() : '';
  if (!isKind(kind) || !subject || !content) return null;

  return {
    kind,
    subject,
    content,
    confidence: clamp01(r.confidence, 0.9),
    importance: clamp01(r.importance, 0.5),
    sourceRun: runId,
  };
}

function isKind(value: unknown): value is StructuredKind {
  return typeof value === 'string' && (STRUCTURED_KINDS as readonly string[]).includes(value);
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;
}

/** Split text on paragraph/sentence boundaries into ~maxLen pieces. */
export function chunkText(text: string, maxLen: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const chunks: string[] = [];
  let current = '';
  for (const para of trimmed.split(/\n\s*\n/)) {
    if (current && current.length + para.length + 2 > maxLen) {
      chunks.push(current.trim());
      current = '';
    }
    if (para.length > maxLen) {
      // Hard-split an oversized paragraph.
      for (let i = 0; i < para.length; i += maxLen) chunks.push(para.slice(i, i + maxLen).trim());
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}
