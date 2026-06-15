-- ARES Phase 4 — durable spend ledger for the hard money caps.
--
-- The SpendCapEnforcer (src/safety/caps.ts) checks the rolling-window spend total
-- BEFORE approving any state-mutating call. With an in-memory ledger that total
-- resets on every restart, so the rolling limit silently forgets recent spend and
-- a bounce of the process re-opens the budget. This table makes the rolling window
-- survive restarts: every approved call's cost is appended here, and the enforcer
-- sums the window from it.
--
-- Append-only by intent (we never update or delete a committed cost); a row is one
-- approved, money-moving tool call.

create table if not exists cost_ledger (
  id      uuid primary key default gen_random_uuid(),
  ts      timestamptz not null,           -- when the cost was committed
  tool    text not null,                  -- the tool whose call incurred it
  amount  numeric(20,4) not null          -- the monetary amount (same unit as the caps)
);

-- The only query path is "sum of amount since <window start>", so index ts.
create index if not exists cost_ledger_ts_idx on cost_ledger (ts);
