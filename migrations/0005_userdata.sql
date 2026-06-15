-- ARES Phase 5 hardening — durable user data: notification history, tasks, and
-- persisted tool permissions.
--
-- These close three persistence gaps from the audit:
--   * notifications     — a history of everything the notify tool delivered, so the
--                         dashboard can show "what has ARES told me", not just the
--                         transient terminal/push at delivery time.
--   * tasks             — the principal's task list ARES creates and manages. Until
--                         now "tasks" lived only as structured_memory of kind project;
--                         a first-class table gives status/priority/due-date queries.
--   * tool_permissions  — the registry's enable/disable toggles were in-memory only,
--                         so a disabled (e.g. risky) tool silently re-enabled on
--                         restart. This makes an operator's toggle durable.

-- ---------------------------------------------------------------------------
-- notifications: one row per delivered notification (append-only in practice;
-- read_at is the only mutable field). source_run links to the run that sent it.
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  urgency     text not null default 'normal' check (urgency in ('low','normal','high')),
  source_run  uuid,                          -- run that produced it (null for manual/system)
  created_at  timestamptz not null default now(),
  read_at     timestamptz                    -- null until the principal marks it read
);

create index if not exists notifications_created_idx on notifications (created_at desc);
create index if not exists notifications_unread_idx on notifications (created_at desc) where read_at is null;

-- ---------------------------------------------------------------------------
-- tasks: the principal's actionable items. status drives the lifecycle;
-- completed_at is set when status becomes 'done'.
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  status       text not null default 'todo'
                 check (status in ('todo','in_progress','done','cancelled')),
  priority     text not null default 'normal'
                 check (priority in ('low','normal','high','urgent')),
  detail       text not null default '',
  project      text,                         -- optional grouping (a project subject)
  due_at       timestamptz,
  source_run   uuid,                         -- run that created it (null for manual/UI)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz                   -- set when status -> 'done'
);

create index if not exists tasks_status_idx on tasks (status, priority, created_at desc);
create index if not exists tasks_due_idx on tasks (due_at) where due_at is not null;

-- ---------------------------------------------------------------------------
-- tool_permissions: durable enable/disable overrides for registry tools. A row
-- exists only for a tool whose state was explicitly changed; absence = default
-- (enabled). `enabled = false` means an operator disabled it.
-- ---------------------------------------------------------------------------
create table if not exists tool_permissions (
  tool       text primary key,
  enabled    boolean not null,
  changed_at timestamptz not null default now(),
  changed_by text
);
