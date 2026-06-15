/**
 * Memory backend wiring.
 *
 * One place that decides, from config, whether ARES runs on durable Postgres
 * memory or the in-memory fallback — and assembles the embeddings client,
 * stores, retriever, ingestor, and audit log accordingly. Both the app entry
 * point and the consolidation CLI build their world through here so the
 * "with DB / without DB" branching exists exactly once.
 *
 * Persistence is the intended mode. The in-memory fallback exists only so the
 * agent is runnable with zero infra; it logs a warning so it's never mistaken
 * for real memory.
 */

import type { Config } from '../config.js';
import type { AuditLog, Logger, MemoryRetriever, MemoryWriter } from '../types.js';
import type { MessageClient } from '../agent/orchestrator.js';
import { PgDb, type Db } from '../db/client.js';
import { InMemoryAuditLog } from '../logging/logger.js';
import { PostgresAuditLog } from '../logging/pgAuditLog.js';
import {
  HashEmbeddingClient,
  VoyageEmbeddingClient,
  GeminiEmbeddingClient,
  type EmbeddingClient,
} from './embeddings.js';
import {
  InMemorySemanticStore,
  InMemoryStructuredStore,
  type SemanticStore,
  type StructuredStore,
} from './stores.js';
import { PgSemanticStore, PgStructuredStore } from './pgStores.js';
import { DbMemoryRetriever } from './retriever.js';
import { MemoryIngestor } from './ingestor.js';
import { InMemoryMemoryQueue, QueuedMemoryWriter, type MemoryQueue } from './queue.js';
import { createBullMqMemoryQueue } from './bullmqQueue.js';

export interface MemoryBackend {
  retriever: MemoryRetriever;
  memoryWriter: MemoryWriter;
  audit: AuditLog;
  embeddings: EmbeddingClient;
  semantic: SemanticStore;
  structured: StructuredStore;
  /** Present only when running on Postgres; call to release the pool on shutdown. */
  db?: Db;
  /** True when running on durable Postgres memory. */
  persistent: boolean;
  /**
   * Wait for queued memory ingestion and asynchronous audit writes to finish.
   * One-shot CLIs must await this before exit; long-lived processes call it on
   * shutdown before closing the shared database pool.
   */
  flushMemory(): Promise<void>;
}

export function buildMemoryBackend(
  config: Config,
  client: MessageClient,
  logger: Logger,
): MemoryBackend {
  const embeddings = buildEmbeddings(config, logger);

  let semantic: SemanticStore;
  let structured: StructuredStore;
  let audit: AuditLog;
  let db: Db | undefined;
  const persistent = Boolean(config.databaseUrl);

  if (config.databaseUrl) {
    db = new PgDb(config.databaseUrl);
    semantic = new PgSemanticStore(db);
    structured = new PgStructuredStore(db);
    audit = new PostgresAuditLog(db, logger);
  } else {
    logger.warn(
      'No DATABASE_URL set — using in-memory memory + audit. State will NOT persist across restarts.',
    );
    semantic = new InMemorySemanticStore();
    structured = new InMemoryStructuredStore();
    audit = new InMemoryAuditLog(logger);
  }

  const retriever = new DbMemoryRetriever({ semantic, structured, embeddings });
  const ingestor = new MemoryIngestor({
    client,
    embeddings,
    semantic,
    structured,
    logger,
  });
  // Run ingestion off the hot path: the orchestrator only enqueues; a worker
  // drains. Durable BullMQ queue when REDIS_URL is set (enqueued exchanges survive
  // a crash); the in-process queue otherwise.
  let queue: MemoryQueue;
  let closeQueue: () => Promise<void> = async () => {};
  if (config.redisUrl) {
    const durable = createBullMqMemoryQueue(config.redisUrl, logger);
    durable.startWorker(ingestor); // in-process worker; a dedicated one could run instead
    queue = durable;
    closeQueue = () => durable.close();
    logger.info('memory ingestion queue: bullmq (durable)');
  } else {
    queue = new InMemoryMemoryQueue(ingestor, logger);
  }
  const memoryWriter = new QueuedMemoryWriter(queue);
  const flushAudit = audit instanceof PostgresAuditLog
    ? () => audit.flush()
    : async () => {};

  return {
    retriever,
    memoryWriter,
    audit,
    embeddings,
    semantic,
    structured,
    persistent,
    flushMemory: async () => {
      await queue.drain();
      await flushAudit();
      await closeQueue();
    },
    ...(db ? { db } : {}),
  };
}

export function buildEmbeddings(config: Config, logger: Logger): EmbeddingClient {
  const wantGemini =
    config.embeddingProvider === 'gemini' ||
    (config.embeddingProvider === 'auto' && !config.voyageApiKey && Boolean(config.geminiApiKey));
  const wantVoyage =
    config.embeddingProvider === 'voyage' ||
    (config.embeddingProvider === 'auto' && Boolean(config.voyageApiKey));

  if (wantGemini) {
    if (!config.geminiApiKey) {
      throw new Error('ARES_EMBEDDING_PROVIDER=gemini but no GEMINI_API_KEY is set.');
    }
    return new GeminiEmbeddingClient({
      apiKey: config.geminiApiKey,
      model: config.geminiEmbeddingModel,
      dimension: config.embeddingDim,
    });
  }

  if (wantVoyage) {
    if (!config.voyageApiKey) {
      throw new Error('ARES_EMBEDDING_PROVIDER=voyage but no VOYAGE_API_KEY is set.');
    }
    return new VoyageEmbeddingClient({
      apiKey: config.voyageApiKey,
      model: config.embeddingModel,
      dimension: config.embeddingDim,
    });
  }

  logger.warn(
    'No embeddings provider key set — using the offline hash embedder. Semantic recall will be poor; ' +
      'set VOYAGE_API_KEY or GEMINI_API_KEY for real embeddings.',
  );
  return new HashEmbeddingClient(config.embeddingDim);
}
