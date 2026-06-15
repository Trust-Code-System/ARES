---
name: prompt-compression
description: Compress prompts and context to cut tokens without losing meaning. Use when a system prompt is bloated, costs are too high, you're near a context limit, or you need to summarize a long history into a compact briefing.
---

# Prompt Compression

Say the same thing in fewer tokens. Distilled from the MIT
`Agent-Skills-for-Context-Engineering` (context-compression, latent-briefing).

## When to use
Bloated/rambling system prompts; high token cost; nearing the window limit; turning a long
conversation or document set into a tight briefing for the next step or a sub-agent.

## Principles
- **Instructions over examples (then a few examples).** A crisp rule plus 1–2 examples beats
  ten verbose examples. Cut redundant demonstrations.
- **Imperative, deduplicated.** One clear statement per rule. Delete restatements, hedging,
  and meta-talk ("In this section we will…"). Merge overlapping rules.
- **Reference, don't inline.** Point to skills/files/tools for detail instead of pasting it.
  Load detail on demand (progressive disclosure) rather than carrying it always.
- **Summaries preserve decisions, not dialogue.** When compacting history, keep: goal,
  decisions made, open questions, constraints, and current state. Drop pleasantries and the
  step-by-step that led there.
- **Structured > prose for data.** Tables/lists/JSON compress better and parse cleaner than
  paragraphs for the same facts.
- **Briefing for handoff.** When passing context to a sub-agent, write a task-guided briefing:
  only what *that* agent needs to act, framed as its objective + inputs + constraints.

## Process
1. Identify the audience (model now / sub-agent / future session) and what it must do.
2. Extract the load-bearing content; discard the rest.
3. Rewrite imperatively; merge duplicates; convert data to structure.
4. Verify nothing semantically required was lost (constraints, edge cases, safety rules).

## Output format
The compressed text, plus a one-line note on what was dropped and why, so the cut is auditable.

## Safety rules
Never compress away safety constraints, scope limits, or explicit user instructions — those
are load-bearing by definition. When unsure if something is required, keep it.
