create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null,
  category text not null,
  enabled boolean not null default false,
  risk_level text not null default 'medium',
  source_repo text,
  license_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references skills(id) on delete cascade,
  version text not null,
  manifest jsonb not null,
  skill_markdown text not null,
  created_at timestamptz not null default now(),
  unique(skill_id, version)
);

create table if not exists skill_sources (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid references skills(id) on delete cascade,
  repo_url text not null,
  commit_sha text,
  imported_at timestamptz not null default now(),
  imported_by text
);

create table if not exists skill_audit_results (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid references skills(id) on delete cascade,
  status text not null,
  findings jsonb not null default '[]'::jsonb,
  scanned_at timestamptz not null default now()
);

create table if not exists skill_permissions (
  skill_id uuid not null references skills(id) on delete cascade,
  permission text not null,
  risk_level text not null,
  confirmation_required boolean not null default false,
  primary key (skill_id, permission)
);

create table if not exists skill_execution_logs (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid references skills(id) on delete set null,
  run_id text,
  status text not null,
  input_summary text,
  output_summary text,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists agent_personas (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  role text not null,
  persona jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists memory_items (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  subject text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id text,
  tool_name text not null,
  risk_level text not null,
  confirmation_required boolean not null default false,
  status text not null,
  input_redacted jsonb,
  output_redacted jsonb,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists confirmations (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  risk_level text not null,
  permissions text[] not null default '{}',
  status text not null default 'pending',
  requested_by text,
  resolved_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists project_context (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null,
  content text not null,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  title text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  title text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists research_sources (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete set null,
  url text,
  title text,
  citation text,
  retrieved_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
