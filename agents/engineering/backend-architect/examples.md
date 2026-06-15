# Examples — backend-architect

## Request
"Design the backend for a feature where users can schedule reports to be emailed daily."

## Good output (shape)
1. **Recommendation** — store schedules in Postgres, run delivery on the existing
   BullMQ scheduler; one row per schedule, idempotent per (schedule_id, date).
2. **API contract** — `POST /reports/schedules`, `GET/DELETE /reports/schedules/:id`
   with payloads and error codes.
3. **Schema** — `report_schedules(id, user_id, cron, params jsonb, created_at)` +
   `report_runs(schedule_id, run_date, status)` with a unique index for idempotency.
4. **Failure modes** — duplicate fire, email bounce, schedule deleted mid-run.
5. **Trade-off** — cron-in-DB vs external scheduler; reverse if volume > N/min.
