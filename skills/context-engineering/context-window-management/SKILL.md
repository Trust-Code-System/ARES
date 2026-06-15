---
name: context-window-management
description: Diagnose and fix context-window problems in long agent runs — degradation, lost-in-the-middle, distraction, poisoning. Use when an agent gets worse over a long session, ignores earlier instructions, or hits token limits, and to apply compaction/masking/caching.
---

# Context Window Management

Long sessions degrade in predictable ways. This is how to keep a context window healthy.
Distilled from the MIT `Agent-Skills-for-Context-Engineering` (context-degradation,
context-optimization).

## When to use
An agent that drifts, repeats itself, forgets early constraints, or slows/errors as a run
grows; deciding what to keep vs drop when nearing the token budget.

## Degradation failure modes (name the one you're seeing)
- **Lost-in-the-middle** — the model attends to the start and end of context, neglecting the
  middle. Fix: put the most important instructions at the very top *and* restate the active
  goal near the end.
- **Distraction** — irrelevant retrieved chunks or tool output crowd out signal. Fix: tighter
  retrieval (higher relevance threshold, fewer k), summarize tool results before feeding back.
- **Poisoning** — a wrong fact or hallucination enters context and gets reinforced. Fix:
  verify before persisting; don't echo unverified model claims back into context as fact.
- **Bloat** — raw transcripts/files pile up. Fix: compaction (below).

## Techniques
- **Compaction** — periodically replace old turns with a dense summary that preserves
  decisions, open threads, and constraints; drop the verbatim back-and-forth.
- **Masking** — hide tool schemas/context the current step doesn't need; reveal progressively
  (the `find_skill`/`use_skill` pattern is masking applied to a skill library).
- **Caching** — keep the stable prefix (system prompt, tool defs) identical so the provider's
  prompt cache hits; put volatile content after it. Don't reorder the prefix mid-session.
- **Externalize** — push large artifacts to files/memory and keep only a pointer in context.

## Output format
Name the failure mode, the cause, and the specific fix (with the changed prompt ordering,
retrieval params, or compaction trigger).

## Safety rules
Compaction must not silently drop safety constraints or user instructions — carry those
forward verbatim in every summary.
