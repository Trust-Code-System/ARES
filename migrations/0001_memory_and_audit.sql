-- ARES Phase 2 — Memory + durable audit.
--
-- Two memory stores plus the immutable audit log, as required by the core
-- principles ("All memory is persisted to a database, never to flat files" and
-- "Full audit log of every decision and action, immutable").
--
-- IMPORTANT: the semantic_memory.embedding column is fixed at vector(1024),
-- which matches the default ARES embedding model (voyage-3.5, 1024 dims). If you
-- switch embedding models you MUST change this dimension and re-embed — pgvector
-- columns are fixed-width. ARES_EMBEDDING_DIM in .env must agree with this value;
-- the migration runner asserts it on startup.

create extension if not exists vector;
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- structured_memory: typed facts, people, projects, preferences, decisions.
--
-- One table with a `kind` discriminator rather than five tables. The tradeoff:
-- we give up per-kind columns but gain a single retrieval path and trivial
-- cross-kind queries ("everything about subject X"). Kind-specific structure
-- lives in `attributes` (jsonb), validated in code (see memory/types.ts), not by
-- the DB. dedupe_key makes (re-)ingesting the same fact idempotent.
-- ---------------------------------------------------------------------------
create table if not exists structured_memory (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('fact','person','project','preference','decision')),
  subject     text not null,                 -- the entity/topic this is about
  content     text not null,                 -- the canonical statement, human-readable
  attributes  jsonb not null default '{}',   -- kind-specific structured fields
  confidence  real not null default 1.0 check (confidence >= 0 and confidence <= 1),
  importance  real not null default 0.5 check (importance >= 0 and importance <= 1),
  source_run  uuid,                           -- run that produced this fact (nullable: seeds/imports)
  dedupe_key  text not null,                  -- normalized kind:subject:content for idempotent upsert
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  superseded_at timestamptz                   -- set by consolidation when a newer fact replaces this
);

create unique index if not exists structured_memory_dedupe_key_idx
  on structured_memory (dedupe_key);
create index if not exists structured_memory_kind_subject_idx
  on structured_memory (kind, subject);
create index if not exists structured_memory_subject_trgm_idx
  on structured_memory using gin (to_tsvector('english', subject || ' ' || content));

-- ---------------------------------------------------------------------------
-- semantic_memory: embedded chunks of conversations, documents, and events.
-- Retrieved by cosine distance against the query embedding (top-k).
-- ---------------------------------------------------------------------------
create table if not exists semantic_memory (
  id          uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('conversation','document','event','summary')),
  source_ref  text,                          -- e.g. run id, file path, message id
  content     text not null,
  embedding   vector(1024) not null,
  metadata    jsonb not null default '{}',
  importance  real not null default 0.5 check (importance >= 0 and importance <= 1),
  created_at  timestamptz not null default now(),
  superseded_at timestamptz                   -- set when a consolidation summary replaces this chunk
);

-- HNSW gives good recall/latency without training; cosine ops match the
-- normalized embeddings we store. Partial index skips superseded rows.
create index if not exists semantic_memory_embedding_idx
  on semantic_memory using hnsw (embedding vector_cosine_ops);
create index if not exists semantic_memory_source_idx
  on semantic_memory (source_type, created_at desc);

-- ---------------------------------------------------------------------------
-- audit_log: append-only record of every decision and action (immutable).
-- A trigger forbids UPDATE/DELETE so the trail cannot be rewritten.
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id        bigint generated always as identity primary key,
  run_id    uuid not null,
  ts        timestamptz not null default now(),
  type      text not null,
  detail    jsonb not null default '{}'
);

create index if not exists audit_log_run_idx on audit_log (run_id, id);

create or replace function audit_log_is_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only; % is not permitted', tg_op;
end;
$$ language plpgsql;

drop trigger if exists audit_log_no_mutate on audit_log;
create trigger audit_log_no_mutate
  before update or delete on audit_log
  for each row execute function audit_log_is_append_only();
