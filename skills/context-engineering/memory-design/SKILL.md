---
name: memory-design
description: Design an agent's memory architecture — what to remember, where, and how to retrieve it. Use when building or debugging agent memory, deciding short-term vs long-term storage, choosing between vector/structured/graph memory, or when an agent forgets or hallucinates facts it should know.
---

# Memory Design

How to give an agent durable, useful memory without bloating its context. Distilled from
the MIT `Agent-Skills-for-Context-Engineering` (memory-systems).

## When to use
Designing memory for an assistant; deciding what persists across sessions; an agent that
repeats questions, forgets preferences, or recalls stale facts.

## The three memory tiers (pick deliberately per fact)
1. **Short-term (working) memory** — the live conversation/context window. Volatile, fast,
   small. Hold only what the current task needs.
2. **Long-term memory** — persisted across sessions. Two complementary stores:
   - **Structured** — typed, deduplicated facts (preferences, projects, decisions, people).
     Exact recall, cheap, queryable. Best for "what do I know about X".
   - **Semantic (vector)** — embedded chunks of past conversations/documents, retrieved by
     similarity. Best for "have we discussed something like this".
3. **Graph memory** — entities + relationships, when the *connections* between facts matter
   (org charts, dependency webs). Heavier; use only when relational queries are the point.

## Design rules
- **Write durable, not transient.** Store preferences, decisions, stable facts — not the
  blow-by-blow of a chat. Extract facts on a schema; dedupe on a normalized key.
- **Retrieve, then reason.** Pull top-k relevant memory into context *before* the model
  reasons — don't make it ask. Keep retrieved context small and ranked.
- **Never delete; supersede.** Mark old facts superseded with a timestamp; exclude from
  retrieval but keep the trail. Preserves auditability and lets you undo bad writes.
- **Consolidate periodically.** A nightly pass that dedupes near-identical chunks and
  summarizes old conversations keeps recall sharp and storage bounded.
- **Memory is untrusted-ish.** A recalled fact reflects what was true when written — verify
  before acting on anything that may have changed (a filename, a flag, a price).

## Output format
A memory spec: which tier each fact class lives in, the write trigger, the retrieval query,
the dedupe key, and the consolidation cadence.

## Safety rules
Don't store secrets/credentials in memory unless the user explicitly asks. Don't let the
model silently write memory the user can't see or revoke — surface and make it reversible.
