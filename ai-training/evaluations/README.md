# Evaluations

Held-out evaluation sets and before/after results for tuned models. Keep eval
examples **separate** from training data — no leakage — so accuracy deltas are real.

Use the `test` partition from `npm run train:split` as a starting eval set, and
mirror the project's deterministic harness (`tests/routing.eval.test.ts`). Store a
baseline result here before tuning and the tuned result after, so a regression is
obvious. See [`docs/AI_TRAINING_STRATEGY.md`](../../docs/AI_TRAINING_STRATEGY.md).
