---
name: tool-orchestration
description: Design agent tools and orchestrate how an agent selects and sequences them. Use when adding/redesigning a tool, when an agent misuses tools or calls the wrong one, or when planning a multi-step tool workflow.
---

# Tool Orchestration

A tool is a contract between the model and the world. Good tools make the right action
obvious; bad tools cause loops and misuse. Distilled from the MIT
`Agent-Skills-for-Context-Engineering` (tool-design).

## When to use
Defining a new tool; the agent picks the wrong tool, passes bad arguments, or loops; planning
how several tools chain to complete a task.

## Tool design contract
- **Name for intent, describe for WHEN.** The description should say *when to reach for this*,
  not just what it does. Disambiguate from sibling tools explicitly.
- **Schema is the source of truth.** Typed, validated inputs (e.g. Zod → JSON schema); reject
  malformed args with a readable error instead of running. Required fields minimal and clear.
- **Return model-useful output.** Concise, structured, and bounded — cap large outputs and
  summarize. The result is context the model must reason over; don't dump raw blobs.
- **Side effects are explicit.** Mark state-mutating tools and route them through a
  confirmation gate enforced in code, not in the prompt. Read-only tools run freely.
- **Idempotent + recoverable.** Safe to retry; on failure return a clear, actionable error so
  the model can adapt rather than blindly retry.

## Orchestration
- **Fewer, sharper tools** beat many overlapping ones — overlap causes wrong-tool selection.
- **Progressive disclosure** for large tool/skill sets: a search tool to find the right
  capability, then load it — don't put 200 schemas in context at once.
- **Plan → act → observe → adapt.** Encourage the agent to check tool output before the next
  call; cap iterations to prevent runaway loops.
- **Sequence by dependency.** Read/gather before write; confirm before irreversible actions.

## Output format
For a new tool: name, when-to-use description, input schema, side-effect class (read/mutate),
output shape, failure behavior. For orchestration: the tool sequence with guard conditions.

## Safety rules
Never let the prompt alone enforce that a mutating tool is "safe" — gate it in code. Surface
blocked/denied calls so the agent re-plans instead of retrying.
