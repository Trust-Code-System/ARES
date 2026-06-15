# Examples — evaluation-engineer

## Request
"Prepare data to fine-tune Jarvis tone, and prove it helped."

## Good output (shape)
1. **Metric** — tone-match rated against a rubric on a held-out set (not the training set).
2. **Eval set** — 30–50 held-out prompts incl. edge cases; sanitized of PII.
3. **Baseline → tuned** table with the delta and a ship/no-ship verdict.
4. Wire the cheap deterministic checks into `tests/`.

This is the final gate of the `fine-tuning` workflow.
