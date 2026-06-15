-- ARES Phase 4 — Autonomy control plane: the kill switch + the activity feed.
--
-- These back the two safety-critical primitives every autonomous run must pass
-- through:
--   * kill_switch  — a single, durable flag that instantly pauses ALL autonomous
--                    activity. Checked before a run starts and polled during it,
--                    so an engaged switch both blocks new runs and aborts in-flight
--                    ones — even when engaged from a separate process (the CLI/UI).
--   * activity_feed — the user-facing record of every autonomous task ARES ran,
--                     skipped, or failed. Distinct from audit_log: audit_log is the
--                     low-level immutable event stream; this is the high-level
--                     "what has ARES been doing" view the dashboard renders.

-- ---------------------------------------------------------------------------
-- kill_switch: a singleton row. The `id` column is pinned to TRUE with a CHECK
-- so there can only ever be one row — `engaged` is the global pause state.
-- ---------------------------------------------------------------------------
create table if not exists kill_switch (
  id          boolean primary key default true,
  engaged     boolean not null default false,
  reason      text,                          -- why it was engaged; null when running
  changed_at  timestamptz not null default now(),
  changed_by  text,                          -- who toggled it (cli, ui, system)
  constraint kill_switch_singleton check (id)
);

-- Seed the single row in the "running" (not engaged) state. Idempotent.
insert into kill_switch (id, engaged) values (true, false)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- activity_feed: one row per autonomous task. `run_id` links to the audit_log
-- run once the agent actually starts (null for tasks skipped by the kill switch).
-- ---------------------------------------------------------------------------
create table if not exists activity_feed (
  id          uuid primary key default gen_random_uuid(),
  trigger     text not null,                 -- 'manual', 'schedule:morning_briefing', 'webhook:...'
  run_id      uuid,                          -- null until/unless the agent run starts
  status      text not null default 'running'
                check (status in ('running','completed','failed','skipped','aborted')),
  detail      text not null default '',
  started_at  timestamptz not null default now(),
  finished_at timestamptz                    -- null while still running
);

create index if not exists activity_feed_started_idx
  on activity_feed (started_at desc);
create index if not exists activity_feed_status_idx
  on activity_feed (status, started_at desc);
