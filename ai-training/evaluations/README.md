# Evaluations

Held-out evaluation sets and before/after results for tuned models. Keep eval
examples **separate** from training data — no leakage — so accuracy deltas are real.

Use the `test` partition from `npm run train:split` as a starting eval set, and
mirror the project's deterministic harness (`tests/routing.eval.test.ts`). Store a
baseline result here before tuning and the tuned result after, so a regression is
obvious. See [`docs/AI_TRAINING_STRATEGY.md`](../../docs/AI_TRAINING_STRATEGY.md).

## Behavioural eval suite

`ares-behavior.v1.json` is the deterministic behavioural suite, run with
`npm run eval` (engine in [`src/evaluation/`](../../src/evaluation/)). Each case
is a `probe` against a real ARES guarantee — no model calls:

| probe | asserts | backed by |
| --- | --- | --- |
| `tool_gating` | a tool requires confirmation (or not) | tool `kind` → `src/safety/gate.ts` |
| `tool_presence` | a capability is registered | `ToolRegistry` |
| `privacy` | input with a secret is blocked | `src/security/redactor.ts` |
| `skill_routing` | a request reaches the expected skill | the vendored skill index |
| `llm_judge` | model-graded behaviour | **SKIPPED** — needs an LLM judge |

The CLI exits non-zero only on a FAIL (skips don't gate CI). Add cases by editing
the JSON; bump the version for a new suite. The shipped suite is also asserted in
`tests/evaluation.test.ts` so a broken guarantee fails the unit run too.

`llm_judge` probes are SKIPPED by default. Run `npm run eval -- --judge` to grade
them with the configured model: ARES answers each case input under its safety
prompt and a strict grader returns pass/fail (see `src/evaluation/judge.ts`). This
needs an LLM key and costs tokens, so it's opt-in and not part of the offline run.
