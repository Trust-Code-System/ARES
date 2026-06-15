/**
 * Phase 2 — Memory. No network and no database: the offline hash embedder and
 * the in-memory stores let the whole pipeline run deterministically, and a fake
 * MessageClient stands in for the model.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent, type MessageClient } from '../src/agent/orchestrator.js';
import type { CreateMessageParams } from '../src/llm/anthropic.js';
import { HashEmbeddingClient } from '../src/memory/embeddings.js';
import {
  InMemorySemanticStore,
  InMemoryStructuredStore,
  cosine,
} from '../src/memory/stores.js';
import { DbMemoryRetriever } from '../src/memory/retriever.js';
import { MemoryIngestor, chunkText } from '../src/memory/ingestor.js';
import { InMemoryMemoryQueue, QueuedMemoryWriter } from '../src/memory/queue.js';
import { PostgresAuditLog } from '../src/logging/pgAuditLog.js';
import { dedupeKey } from '../src/memory/types.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Db, QueryResult } from '../src/db/client.js';
import type { Logger, MemoryRetriever, MemoryTurn, MemoryWriter } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

describe('dedupe key', () => {
  it('normalizes whitespace and case so restatements collapse', () => {
    assert.equal(
      dedupeKey('preference', '  User ', 'Likes   Dark   Mode'),
      dedupeKey('preference', 'user', 'likes dark mode'),
    );
  });
});

describe('hash embedder', () => {
  it('is deterministic, normalized, and dimensionally correct', async () => {
    const e = new HashEmbeddingClient(256);
    const [a1] = await e.embed(['the morning briefing'], 'query');
    const [a2] = await e.embed(['the morning briefing'], 'document');
    assert.equal(a1!.length, 256);
    assert.deepEqual(a1, a2);
    assert.ok(Math.abs(Math.sqrt(a1!.reduce((s, v) => s + v * v, 0)) - 1) < 1e-9);
  });

  it('places related text closer than unrelated text under cosine', async () => {
    const e = new HashEmbeddingClient(512);
    const [q, near, far] = await e.embed(
      ['calendar meeting schedule', 'schedule a calendar meeting', 'photosynthesis in plants'],
      'document',
    );
    assert.ok(cosine(q!, near!) > cosine(q!, far!));
  });
});

describe('chunkText', () => {
  it('keeps short text whole and drops empties', () => {
    assert.deepEqual(chunkText('hello world', 1200), ['hello world']);
    assert.deepEqual(chunkText('   ', 1200), []);
  });

  it('splits long text into bounded pieces', () => {
    const para = 'x'.repeat(900);
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 1000);
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.length <= 1000));
  });
});

describe('in-memory structured store', () => {
  it('upserts on the dedupe key and keeps the higher importance', async () => {
    const store = new InMemoryStructuredStore();
    await store.upsert({ kind: 'preference', subject: 'user', content: 'likes dark mode', importance: 0.4 });
    await store.upsert({ kind: 'preference', subject: 'User', content: 'Likes dark mode', importance: 0.9 });

    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.importance, 0.9);
  });

  it('searches lexically across subject and content', async () => {
    const store = new InMemoryStructuredStore();
    await store.upsert({ kind: 'project', subject: 'Helios', content: 'solar inverter firmware' });
    await store.upsert({ kind: 'person', subject: 'Dana', content: 'lead engineer on Helios' });

    const hits = await store.search('helios', 5);
    assert.equal(hits.length, 2);
    const people = await store.search('helios', 5, ['person']);
    assert.deepEqual(people.map((f) => f.subject), ['Dana']);
  });

  it('forgets a fact by id', async () => {
    const store = new InMemoryStructuredStore();
    const fact = await store.upsert({
      kind: 'preference',
      subject: 'user',
      content: 'prefers concise answers',
    });
    assert.equal(await store.remove(fact.id), true);
    assert.equal((await store.all()).length, 0);
    assert.equal(await store.remove(fact.id), false);
  });
});

describe('in-memory semantic store', () => {
  it('returns the top-k most similar chunks, filtered by minSimilarity', async () => {
    const e = new HashEmbeddingClient(512);
    const store = new InMemorySemanticStore();
    const texts = ['quarterly revenue report', 'revenue grew last quarter', 'cat videos'];
    const embeddings = await e.embed(texts, 'document');
    await store.add(
      texts.map((content) => ({ sourceType: 'conversation' as const, content })),
      embeddings,
    );

    const [q] = await e.embed(['revenue report for the quarter'], 'query');
    const hits = await store.search(q!, 2, 0.05);
    assert.ok(hits.length >= 1 && hits.length <= 2);
    assert.ok(hits[0]!.content.includes('revenue'));
    assert.ok(hits.every((h) => h.similarity >= 0.05));
  });
});

describe('DbMemoryRetriever', () => {
  it('folds structured facts and semantic hits into a context block', async () => {
    const e = new HashEmbeddingClient(512);
    const structured = new InMemoryStructuredStore();
    const semantic = new InMemorySemanticStore();
    await structured.upsert({ kind: 'preference', subject: 'user', content: 'prefers concise answers' });
    const chunkText = 'user asked for a concise summary of the report';
    await semantic.add(
      [{ sourceType: 'conversation', content: chunkText }],
      await e.embed([chunkText], 'document'),
    );

    const retriever = new DbMemoryRetriever({ semantic, structured, embeddings: e, minSimilarity: 0 });
    const context = await retriever.retrieve('give me a concise summary');

    assert.match(context, /### Known facts/);
    assert.match(context, /\[preference\] user: prefers concise answers/);
    assert.match(context, /### Relevant past context/);
  });

  it('returns an empty string when nothing matches', async () => {
    const retriever = new DbMemoryRetriever({
      semantic: new InMemorySemanticStore(),
      structured: new InMemoryStructuredStore(),
      embeddings: new HashEmbeddingClient(128),
    });
    assert.equal(await retriever.retrieve('anything'), '');
  });
});

describe('MemoryIngestor', () => {
  it('embeds the exchange and upserts only valid extracted facts', async () => {
    const structured = new InMemoryStructuredStore();
    const semantic = new InMemorySemanticStore();
    const client = new ForcedToolClient({
      facts: [
        { kind: 'person', subject: 'Dana', content: 'is the lead engineer' },
        { kind: 'nonsense', subject: 'x', content: 'invalid kind dropped' },
        { kind: 'fact', subject: '', content: 'empty subject dropped' },
      ],
    });
    const ingestor = new MemoryIngestor({
      client,
      embeddings: new HashEmbeddingClient(128),
      semantic,
      structured,
      logger,
    });

    await ingestor.ingest({
      runId: 'run-1',
      source: 'user',
      userText: 'Dana is the lead engineer.',
      assistantText: 'Noted.',
    });

    const facts = await structured.all();
    assert.deepEqual(facts.map((f) => f.subject), ['Dana']);
    assert.equal(facts[0]!.sourceRun, 'run-1');
    // The exchange was embedded into semantic memory too.
    const hits = await semantic.search((await new HashEmbeddingClient(128).embed(['Dana'], 'query'))[0]!, 5, 0);
    assert.ok(hits.length >= 1);
  });

  it('never throws when the model call fails', async () => {
    const ingestor = new MemoryIngestor({
      client: { async createMessage() { throw new Error('model down'); } },
      embeddings: new HashEmbeddingClient(128),
      semantic: new InMemorySemanticStore(),
      structured: new InMemoryStructuredStore(),
      logger,
    });
    await assert.doesNotReject(
      ingestor.ingest({ runId: 'r', source: 'user', userText: 'hi', assistantText: 'hello' }),
    );
  });
});

describe('orchestrator ↔ memory writer', () => {
  it('ingests a completed run but skips refusals', async () => {
    const ingested: MemoryTurn[] = [];
    const writer: MemoryWriter = {
      async ingest(turn) { ingested.push(turn); },
    };

    const completed = await runAgent(writer, message('end_turn', [{ type: 'text', text: 'done' }]));
    assert.equal(completed.stopReason, 'completed');
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0]!.assistantText, 'done');

    ingested.length = 0;
    const refused = await runAgent(writer, message('refusal', []));
    assert.equal(refused.stopReason, 'refusal');
    assert.equal(ingested.length, 0);
  });
});

describe('PostgresAuditLog', () => {
  it('queues writes, flushes them to the db, and mirrors for live reads', async () => {
    const db = new FakeDb();
    const audit = new PostgresAuditLog(db, logger);

    audit.record({ runId: 'run-9', ts: new Date().toISOString(), type: 'run_started', detail: { a: 1 } });
    audit.record({ runId: 'run-9', ts: new Date().toISOString(), type: 'run_finished', detail: {} });

    // forRun reads the in-process mirror synchronously.
    assert.equal(audit.forRun('run-9').length, 2);

    await audit.flush();
    const inserts = db.queries.filter((q) => q.sql.includes('insert into audit_log'));
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0]!.params[0], 'run-9');
  });
});

describe('memory queue (off the hot path)', () => {
  const turn: MemoryTurn = { runId: 'r1', source: 'user', userText: 'hi', assistantText: 'yo' };

  it('enqueue returns before the slow ingest finishes, then drain awaits it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let done = false;
    const slowIngestor: MemoryWriter = {
      async ingest() {
        await gate;
        done = true;
      },
    };
    const queue = new InMemoryMemoryQueue(slowIngestor, logger);

    await queue.enqueue(turn);
    assert.equal(done, false); // ingest hasn't completed — it's off the hot path
    assert.equal(queue.pending(), 1);

    release();
    await queue.drain();
    assert.equal(done, true);
    assert.equal(queue.pending(), 0);
  });

  it('swallows ingest failures so a memory error never breaks the turn', async () => {
    const failing: MemoryWriter = { async ingest() { throw new Error('embed down'); } };
    const queue = new InMemoryMemoryQueue(failing, logger);
    await queue.enqueue(turn);
    await assert.doesNotReject(queue.drain());
  });

  it('QueuedMemoryWriter delegates ingest to the queue', async () => {
    const seen: MemoryTurn[] = [];
    const ingestor: MemoryWriter = { async ingest(t) { seen.push(t); } };
    const queue = new InMemoryMemoryQueue(ingestor, logger);
    const writer = new QueuedMemoryWriter(queue);
    await writer.ingest(turn);
    await queue.drain();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.runId, 'r1');
  });
});

// --- helpers ---------------------------------------------------------------

class ForcedToolClient implements MessageClient {
  constructor(private readonly input: unknown) {}
  async createMessage(params: CreateMessageParams): Promise<Anthropic.Message> {
    // Sanity-check the ingestor forces a single tool call with thinking disabled.
    assert.deepEqual(params.toolChoice, { type: 'tool', name: 'record_memory' });
    return message('tool_use', [
      { type: 'tool_use', id: 'toolu_1', name: 'record_memory', input: this.input as object },
    ]);
  }
}

class FakeDb implements Db {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
  async close(): Promise<void> {}
}

async function runAgent(writer: MemoryWriter, response: Anthropic.Message) {
  const memory: MemoryRetriever = { async retrieve() { return ''; } };
  const agent = new Agent({
    client: { async createMessage() { return response; } },
    registry: new ToolRegistry(),
    gate: { async requestApproval() { return { approved: true, reason: 'test' }; } },
    memory,
    memoryWriter: writer,
    logger,
    audit: new InMemoryAuditLog(),
    systemPrompt: 'test',
    maxIterations: 2,
  });
  return agent.run({ text: 'hello', source: 'user' });
}

function message(
  stopReason: Anthropic.Message['stop_reason'],
  content: Anthropic.Message['content'],
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      iterations: [],
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
}
