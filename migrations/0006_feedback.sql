-- ARES Phase 6 — the feedback engine: the missing link between "ARES ran" and
-- "ARES improves". Adapted from the InstructGPT / lm-human-preferences line of
-- work (see docs/github-extraction-report.md): collect human signal on responses
-- and actions, distil it into pairwise preference data, and let that data feed a
-- future DPO/SFT run — WITHOUT ever training on secrets or private data.
--
--   * feedback         — one row per signal the principal gives on a turn/action
--                        (thumbs up/down, a rating, a free-text correction).
--   * preference_pairs  — the canonical {prompt, chosen, rejected} unit. These are
--                        the training-ready records; they come from explicit A/B
--                        choices, from corrections, or are seeded from the audit
--                        log by the action-ranking rules. safety_label carries the
--                        safe-RLHF style helpful/harmless tag.

-- ---------------------------------------------------------------------------
-- feedback: raw signal. rating is -1/0/+1 (down / neutral / up). run_id links to
-- the agent run it concerns (null for free-standing feedback). correction holds
-- the user's "should have been …" text when they fix a response.
-- ---------------------------------------------------------------------------
create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid,                            -- run the feedback is about (null = general)
  target      text not null default 'response' -- what the signal is about
                check (target in ('response', 'action', 'summary', 'other')),
  rating      smallint not null default 0 check (rating in (-1, 0, 1)),
  note        text not null default '',        -- free-text feedback
  correction  text,                            -- the preferred wording, when given
  prompt      text,                            -- the input that produced the target (for later pairing)
  response    text,                            -- the response/action that was rated
  created_at  timestamptz not null default now()
);

create index if not exists feedback_created_idx on feedback (created_at desc);
create index if not exists feedback_run_idx on feedback (run_id) where run_id is not null;

-- ---------------------------------------------------------------------------
-- preference_pairs: training-ready {prompt, chosen, rejected}. source records how
-- the pair was created so we can weight/filter later. safety_label is null for
-- pure quality pairs, or 'safe'/'unsafe_rejected' for harmlessness cases.
-- ---------------------------------------------------------------------------
create table if not exists preference_pairs (
  id           uuid primary key default gen_random_uuid(),
  prompt       text not null,
  chosen       text not null,
  rejected     text not null,
  reason       text not null default '',
  source       text not null default 'manual'
                 check (source in ('manual', 'correction', 'ab_choice', 'action_ranking', 'imported')),
  safety_label text check (safety_label in ('safe', 'unsafe_rejected', 'privacy')),
  created_at   timestamptz not null default now()
);

create index if not exists preference_pairs_created_idx on preference_pairs (created_at desc);
create index if not exists preference_pairs_source_idx on preference_pairs (source);
