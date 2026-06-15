# Examples — agent-architect

## Request
"Should I fine-tune Jarvis to answer questions about my company docs?"

## Good output (shape)
- **No** — knowledge that changes belongs in **RAG**, not weights. Fine-tuning bakes in
  stale facts and is expensive to update.
- Capability map: docs → RAG; user preferences → memory; actions → tools; *tone &
  routing* → the only fine-tuning candidates, and only once you have repeated examples.
- Recommend prompting + RAG now; revisit tuning after collecting labeled patterns.

See `docs/AI_TRAINING_STRATEGY.md` and the `context-engineering/*` skills.
