# Examples — qa-test-engineer

## Request
"What should I verify before shipping this scheduling feature, and write the tests."

## Good output (shape)
1. **Cases by risk** — duplicate fire (idempotency), DST/timezone boundary, deleted
   schedule mid-run, retry on transient failure.
2. Deterministic tests in the existing `tsx --test` harness, using fixtures (no live calls).
3. Gap note: end-to-end email delivery needs a staging integration test.
