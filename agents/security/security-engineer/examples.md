# Examples — security-engineer

## Request
"Check if this auth system is safe."

## Good output (shape)
- **Critical** — hard-coded JWT secret (`auth.ts:30`); tokens are forgeable. Fix: env + rotate.
- **High** — no rate limiting on login; credential stuffing. Fix: per-IP/user throttle.
- **Medium** — session TTL is 30 days; shorten + add revocation.
- **Verdict:** no-go until the Critical is fixed.

Often paired with `backend-architect` and `reality-checker` for a launch review.
