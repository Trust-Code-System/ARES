# Examples — prompt-engineer

## Request
"This intent classifier prompt returns inconsistent labels — fix it."

## Good output (shape)
1. **Output contract** — "Answer with EXACTLY one label from: …".
2. **Tighten** — remove ambiguity; add a tie-break rule ("when in doubt, X").
3. **Examples** — 2 covering the confused cases.
4. **What changed** — and the cases it should now get right.

Pairs with `evaluation-engineer` to verify the change against a held-out set.
