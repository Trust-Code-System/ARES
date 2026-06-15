---
name: multi-agent-workflows
description: Decide whether to use multiple agents and how to coordinate them. Use when a task is too big for one agent, when designing orchestrator/sub-agent systems, or when a multi-agent setup is slow, expensive, or produces inconsistent results.
---

# Multi-Agent Workflows

When and how to split work across agents — and when not to. Distilled from the MIT
`Agent-Skills-for-Context-Engineering` (multi-agent-patterns).

## When to use
A task with separable sub-problems, parallelizable research, or distinct expert roles;
diagnosing a multi-agent system that's slow, costly, or inconsistent.

## First question: do you even need multiple agents?
A single agent with good tools and memory is simpler, cheaper, and easier to debug. Reach for
multi-agent only when: sub-tasks are genuinely independent (parallel speedup), require
isolated context (avoid cross-contamination), or need distinct specialized instructions.

## Coordination patterns
- **Orchestrator–worker (hub & spoke).** A lead agent decomposes the task, dispatches scoped
  sub-tasks to workers, and synthesizes results. Best default — clear ownership, easy to
  reason about. Workers get a *task-guided briefing*, not the whole history.
- **Peer-to-peer.** Agents collaborate as equals (e.g. debate, critique). Powerful for quality
  but harder to control and can loop; bound the rounds.
- **Hierarchical.** Orchestrators of orchestrators for very large tasks. Only when the tree
  genuinely needs depth — each layer adds latency and failure surface.

## Design rules
- **Scope each sub-agent tightly.** One clear objective, the minimal context to achieve it,
  and a defined output contract. Don't hand a worker the orchestrator's entire context.
- **Isolate context, share results.** Workers reason in their own window; only their distilled
  output returns to the orchestrator (limits poisoning and bloat).
- **Make handoffs explicit.** Objective + inputs + constraints + expected output shape.
- **Budget and bound.** Cap rounds/iterations; set a cost ceiling; have a fallback to a single
  agent if coordination overhead dominates.

## Output format
An agent topology: who orchestrates, what each worker owns, the briefing each receives, the
result contract, and the round/cost bounds.

## Safety rules
A sub-agent inherits the same gates and caps as the main agent — splitting work must never
split off the safety layer. Don't let workers take irreversible actions without the gate.
