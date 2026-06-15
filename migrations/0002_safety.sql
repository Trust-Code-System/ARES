-- ARES Phase 3 — Safety: standing rules + the persistent confirmation queue.
--
-- These implement the core principle "Every action that mutates external state
-- requires either a confirmation step or an explicit pre-authorized rule." The
-- gate consults standing_rules first; absent a matching rule and a human, the
-- request is parked in confirmation_queue until approved (so autonomous runs in
-- Phase 4 never silently mutate state, and never block either).

-- ---------------------------------------------------------------------------
-- standing_rules: pre-authorizations (or pre-denials) for tool calls.
--
-- `tool` is a tool name or '*' (any). `match` is a subset predicate: the rule
-- fires when every key in `match` deep-equals the corresponding key in the
-- tool input ({} matches any input). `effect` deny beats allow when both match.
-- ---------------------------------------------------------------------------
create table if not exists standing_rules (
  id          uuid primary key default gen_random_uuid(),
  tool        text not null,
  match       jsonb not null default '{}',
  effect      text not null check (effect in ('allow','deny')),
  reason      text not null default '',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz                    -- null = never expires
);

create index if not exists standing_rules_tool_idx
  on standing_rules (tool) where enabled;

-- ---------------------------------------------------------------------------
-- confirmation_queue: state-mutating calls awaiting a human decision.
-- The UI/CLI resolves these; the gate enqueues them when no human is present.
-- ---------------------------------------------------------------------------
create table if not exists confirmation_queue (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null,
  tool        text not null,
  input       jsonb not null,
  status      text not null default 'pending'
                check (status in ('pending','approved','denied','expired')),
  reason      text not null default '',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create index if not exists confirmation_queue_status_idx
  on confirmation_queue (status, created_at);
create index if not exists confirmation_queue_run_idx
  on confirmation_queue (run_id);
