/**
 * Memory consolidation — the nightly "summarize and dedupe" pass.
 *
 * Semantic memory accretes near-duplicate chunks (the same fact restated across
 * conversations) and stale detail. Left unchecked, retrieval quality degrades
 * and the table grows without bound. This job:
 *
 *   1. DEDUPE: supersede semantic chunks that are near-duplicates of an earlier
 *      chunk (cosine distance below a threshold), keeping the original.
 *   2. SUMMARIZE: collapse the many chunks of an old conversation into a single
 *      'summary' chunk, then supersede the originals.
 *
 * Superseding (rather than deleting) preserves the audit trail — nothing is ever
 * destroyed, it's just excluded from retrieval (the partial-index/`superseded_at`
 * filters do that). This is a Postgres maintenance task by nature, so it targets
 * the {@link Db} directly. Phase 4 schedules it nightly on BullMQ; for now run it
 * with `npm run consolidate`.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db/client.js';
import { toVectorLiteral } from '../db/client.js';
import type { Logger } from '../types.js';
import type { EmbeddingClient } from './embeddings.js';
import type { MessageClient } from '../agent/orchestrator.js';

export interface ConsolidationOptions {
  db: Db;
  embeddings: EmbeddingClient;
  /** Used to summarize old conversations. If omitted, only dedupe runs. */
  client?: MessageClient;
  logger?: Logger;
  /** Cosine distance below which two chunks are considered duplicates. Default 0.05. */
  dedupeDistance?: number;
  /** Conversations whose chunks are older than this are summarized. Default 14. */
  summarizeOlderThanDays?: number;
}

export interface ConsolidationReport {
  duplicatesSuperseded: number;
  conversationsSummarized: number;
  chunksReplacedBySummaries: number;
}

export async function consolidateMemory(
  opts: ConsolidationOptions,
): Promise<ConsolidationReport> {
  const dedupeDistance = opts.dedupeDistance ?? 0.05;
  const summarizeOlderThanDays = opts.summarizeOlderThanDays ?? 14;

  const duplicatesSuperseded = await dedupe(opts.db, dedupeDistance);
  opts.logger?.info('consolidation: dedupe complete', { duplicatesSuperseded });

  let conversationsSummarized = 0;
  let chunksReplacedBySummaries = 0;
  if (opts.client) {
    const result = await summarizeOldConversations(
      opts.db,
      opts.client,
      opts.embeddings,
      summarizeOlderThanDays,
      opts.logger,
    );
    conversationsSummarized = result.conversations;
    chunksReplacedBySummaries = result.chunks;
  }

  return { duplicatesSuperseded, conversationsSummarized, chunksReplacedBySummaries };
}

/** Supersede each live chunk that duplicates an earlier (lower-id) live chunk. */
async function dedupe(db: Db, distance: number): Promise<number> {
  const res = await db.query(
    `with pairs as (
       select b.id as drop_id
         from semantic_memory a
         join semantic_memory b
           on a.created_at <= b.created_at and a.id <> b.id
          and a.superseded_at is null and b.superseded_at is null
          and (a.embedding <=> b.embedding) < $1
     )
     update semantic_memory
        set superseded_at = now()
      where id in (select drop_id from pairs) and superseded_at is null`,
    [distance],
  );
  return res.rowCount;
}

/** Roll up the chunks of conversations older than `days` into summary chunks. */
async function summarizeOldConversations(
  db: Db,
  client: MessageClient,
  embeddings: EmbeddingClient,
  days: number,
  logger?: Logger,
): Promise<{ conversations: number; chunks: number }> {
  const groups = await db.query<{ source_ref: string; ids: string[]; content: string[] }>(
    `select source_ref,
            array_agg(id order by created_at) as ids,
            array_agg(content order by created_at) as content
       from semantic_memory
      where source_type = 'conversation'
        and superseded_at is null
        and source_ref is not null
        and created_at < now() - ($1 || ' days')::interval
      group by source_ref
      having count(*) > 1`,
    [days],
  );

  let conversations = 0;
  let chunks = 0;
  for (const group of groups.rows) {
    const summary = await summarize(client, group.content.join('\n\n'));
    if (!summary) continue;

    const [embedding] = await embeddings.embed([summary], 'document');
    if (!embedding) continue;

    await db.query(
      `insert into semantic_memory (source_type, source_ref, content, embedding, metadata, importance)
       values ('summary', $1, $2, $3, $4, 0.6)`,
      [
        group.source_ref,
        summary,
        toVectorLiteral(embedding),
        JSON.stringify({ summarizedChunks: group.ids.length }),
      ],
    );
    await db.query(`update semantic_memory set superseded_at = now() where id = any($1)`, [
      group.ids,
    ]);

    conversations++;
    chunks += group.ids.length;
    logger?.debug('summarized conversation', {
      sourceRef: group.source_ref,
      chunks: group.ids.length,
    });
  }

  return { conversations, chunks };
}

async function summarize(client: MessageClient, text: string): Promise<string | null> {
  const response = await client.createMessage({
    tier: 'fast',
    thinking: { type: 'disabled' },
    maxTokens: 600,
    system:
      'Summarize the following conversation memory into a few dense, factual sentences. ' +
      'Preserve names, decisions, preferences, and commitments. Drop pleasantries and mechanics.',
    tools: [],
    messages: [{ role: 'user', content: text }],
  });
  const out = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return out || null;
}
