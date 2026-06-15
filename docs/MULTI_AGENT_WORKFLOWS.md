# Multi-Agent Workflows

Reusable orchestrator–worker plans for multi-step work. Templates live in
[`workflows/*.workflow.json`](../workflows); the loader/selector is
[`src/agents/workflows.ts`](../src/agents/workflows.ts).

## When to use multiple agents

**Default to a single agent.** A well-equipped agent with tools, skills, and memory
is simpler, cheaper, and easier to debug. Reach for a workflow only when sub-tasks
are genuinely separable, need isolated context, or need distinct expert roles —
the guidance in the `context-engineering/multi-agent-workflows` skill applies here too.

## Workflow shape

```json
{
  "id": "feature-build",
  "name": "Feature Build Workflow",
  "description": "...",
  "trigger_keywords": ["build feature", "from idea to production"],
  "required_inputs": ["a feature idea or goal"],
  "stages": [
    { "agent": "product/product-manager", "task": "Define requirements", "outputs": "spec", "tools": ["create_task"] }
  ],
  "quality_checks": ["acceptance criteria are testable"],
  "final_deliverable": "A reviewed, tested feature."
}
```

## Available workflows

| id | What it coordinates |
|----|---------------------|
| `feature-build` | PM → UX → backend → frontend → QA → security → reality-check |
| `ui-review` | ui-designer → ux-researcher → frontend-developer |
| `security-review` | security-engineer → backend-architect → reality-checker |
| `launch-readiness` | QA → security → devops → reality-checker |
| `marketing-campaign` | growth-strategist → copywriter → evaluation-engineer |
| `bug-fix` | code-reviewer → developer → QA (regression) |
| `refactor` | code-reviewer → backend-architect → QA (behavior pinning) |
| `fine-tuning` | agent-architect → prompt-engineer → evaluation-engineer → reality-checker |

## Selection

`selectWorkflow(text, workflows)` scores by trigger-phrase containment plus strong
per-keyword overlap and returns the best match or `null`. It's pure and tested
(`tests/workflows.test.ts`). "Build this feature from idea to production" →
`feature-build`.

## Safety

Every worker inherits the **same gate and caps** as the main agent — splitting work
never splits off the safety layer. The `fine-tuning` workflow additionally sets
`requires_sensitive_data_scan: true`; honor it by running `npm run train:validate`
before any dataset leaves the machine.
