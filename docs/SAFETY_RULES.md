# Safety Rules

How the agent + training additions stay safe, and how they reuse ARES's existing
safety layer rather than re-implementing it.

## Hard rules (never)

ARES must never:

- expose API keys or secrets;
- read `.env` (or similar) without explicit permission;
- send project files to unknown/external URLs;
- train on private user data without consent;
- delete or overwrite files without confirmation;
- execute unknown scripts or install packages without confirmation.

These are enforced by the confirmation gate ([`src/safety/gate.ts`](../src/safety/gate.ts)),
spend caps ([`src/safety/caps.ts`](../src/safety/caps.ts)), the SSRF guard
([`src/tools/net/ssrf.ts`](../src/tools/net/ssrf.ts)), and per-tool permissions.
**Agents and workflows inherit all of it** — a persona is guidance and cannot
approve a gated tool call.

## Third-party content (gist + agency-agents)

Anything vendored from the gist or `agency-agents` is treated as **untrusted input**:

- **Prompt-injection / role-hijack / safety-bypass / secret-exfil / curl|sh / exec /
  secret-access** are scanned by the existing skill scanner
  ([`src/skills/scanner.ts`](../src/skills/scanner.ts)) — run `npm run scan:skills`.
  The same rule set (`scanText`) was run over each vendored `agent.md` before it landed.
- **Outdated info** — the gist's Google AI Studio tuning flow is obsolete; see
  [`AI_TRAINING_STRATEGY.md`](./AI_TRAINING_STRATEGY.md). We did not implement it.
- **Licensing** — `agency-agents` is MIT; provenance recorded in each
  `metadata.json` (`source_repo`) and in [`agents/README.md`](../agents/README.md).
- Personas were **rewritten** in ARES's style, not copied verbatim, and contain no
  hidden instructions, secret access, or "ignore previous instructions" language.

## Training-data safety (the new surface)

Training files leave the machine, so they get a dedicated sanitizer
([`src/ai-training/sanitizer.ts`](../src/ai-training/sanitizer.ts)):

- Detects & redacts API keys (OpenAI/Anthropic/Google/AWS/GitHub/Slack), private-key
  blocks, JWTs, bearer tokens, `secret=`/`password=` assignments, emails, IPs, phones.
- `validate` **fails** (non-zero exit) on any hard credential.
- `export` sanitizes implicitly and **refuses** to write if a credential survives.
- Never fine-tune on private user data without explicit consent.

## Agent risk → confirmation

Each persona declares a `risk_level`. The router surfaces it as `needs_confirmation`
(advisory). The runtime gate still independently gates every state-mutating tool —
the router's advice can only *raise* caution, never lower it.
