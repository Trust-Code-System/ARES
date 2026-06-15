---
name: evaluation-loops
description: Build evaluation and debugging loops for agents — deterministic tests, LLM-as-judge scoring, and autonomous improvement harnesses. Use when you need to measure whether an agent works, catch regressions, debug why it fails, or set up an eval-driven iteration loop.
---

# Evaluation Loops

You can't improve what you don't measure. How to evaluate and debug agent behavior. Distilled
from the MIT `Agent-Skills-for-Context-Engineering` (evaluation, advanced-evaluation,
harness-engineering).

## When to use
Verifying an agent does the right thing; catching regressions before shipping; debugging a
failing run; building an automated improve-and-re-test loop.

## Three layers of evaluation (use the cheapest that fits)
1. **Deterministic checks** — assert exact/structured outcomes: did it call the right tool,
   produce valid JSON, route to the right skill, respect a cap? Fast, cheap, no flakiness.
   Make these the backbone of your suite.
2. **LLM-as-judge** — for open-ended quality (writing, design rationale, helpfulness), score
   against an explicit rubric. Rules: give the judge clear criteria + a scale, show it the
   input and the output, ask for a score *and* a reason, and validate the judge against a few
   human-labeled cases. Prefer pairwise comparison ("A vs B") over absolute scores when ranking.
3. **End-to-end behavioral** — run real tasks, check the final state (file written, memory
   updated, no unsafe action). Slowest; reserve for critical paths.

## Debugging a failing run
- **Read the trace, not the vibes.** Inspect each step: model output → tool call → result.
  Find the first step that went wrong; everything after is downstream noise.
- **Isolate the cause:** bad instruction (prompt), wrong/missing context (retrieval/memory),
  bad tool contract (schema/description), or model limitation. Each has a different fix.
- **Reproduce deterministically** with a fixed input before changing anything.

## Harness loops (autonomous improvement)
Lock the metric set first, then let the system iterate: change → re-run the eval suite →
keep if metrics improve, roll back if they regress. Never change the metric to make a run
"pass". Bound iterations and cost.

## Output format
An eval plan: the deterministic assertions, the judge rubric (if any), the behavioral cases,
and the pass threshold. When debugging, the first-failing step and the categorized root cause.

## Safety rules
Evals that exercise mutating tools must run against a sandbox/paper backend, never live
side effects. A judge's score is advisory — it never authorizes a gated action.
