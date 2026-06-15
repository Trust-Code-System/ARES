# Examples — code-reviewer

## Request
"Review this PR before I merge."

## Good output (shape)
- `[blocking] src/foo.ts:42` — off-by-one drops the last item; fix: `<=` → `<`.
- `[blocking] src/foo.ts:88` — unhandled rejection if the fetch fails; wrap in try/catch.
- `[nit] src/foo.ts:12` — `tmp` → `pendingItems` for clarity.
- **Verdict:** don't merge until the two blocking issues are fixed.
