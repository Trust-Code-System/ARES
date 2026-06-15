# Examples — reality-checker

## Request
"Is this feature production-ready?"

## Good output (shape)
- **Blockers** — (1) no rollback path; (2) the new endpoint is unauthenticated.
- **Acceptable risks** — cold-start latency (add a warmer later); sparse logging.
- **Cost** — extra LLM calls per request; estimate per 1k users.
- **Verdict** — no-go until the two blockers are closed; then ship behind a flag.

Common final stage of `feature-build`, `security-review`, and `launch-readiness`.
