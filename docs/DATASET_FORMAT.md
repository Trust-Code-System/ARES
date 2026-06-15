# Dataset Format

Datasets are JSON files under [`ai-training/datasets`](../ai-training/datasets),
named `<name>.v<major>.json`. Types live in
[`src/ai-training/types.ts`](../src/ai-training/types.ts).

## Schema

```json
{
  "name": "jarvis-routing",
  "version": "1.0.0",
  "meta": {
    "description": "Intent + agent/skill/tool routing examples",
    "taskType": "routing",
    "sourceNote": "Hand-authored. No user data."
  },
  "examples": [
    {
      "input": "Make my dashboard look more premium",
      "output": {
        "intent": "improve:design",
        "agent": "design/ui-designer",
        "supporting_agents": ["engineering/frontend-developer"],
        "skills": ["ui-ux/premium-product-design"],
        "tools": [],
        "risk_level": "low",
        "needs_confirmation": false
      },
      "tags": ["routing", "design"]
    }
  ]
}
```

### Example fields

| Field | Required | Notes |
|-------|----------|-------|
| `input` | ✅ | the user/input side (non-empty string) |
| `output` | ✅ | **string** (tone/rewrite/refusal) or **object** (routing/classification) |
| `system` | — | per-example system prompt (recommended for tone sets) |
| `tags` | — | task type, locale (`ng`/`gh`), behavior bucket |
| `id` | — | auto-derived from a content hash when absent |

`output` as an object is serialized to JSON on export, so the model learns to emit
valid structured output.

## Export formats

| `--format` | Shape |
|------------|-------|
| `openai` | OpenAI fine-tuning chat JSONL: one `{ "messages": [system?, user, assistant] }` per line |
| `jsonl` | raw example objects, one per line (inspection / re-import) |
| `csv` | two columns `input,output` (RFC-4180 escaped) |

> Gemini/Vertex uses its own `contents` JSONL shape and a GCP project — see
> [`AI_TRAINING_STRATEGY.md`](./AI_TRAINING_STRATEGY.md). Not emitted by default.

## CLI

```bash
npm run train:validate -- ai-training/datasets/jarvis-routing.v1.json
npm run train:sanitize -- ai-training/datasets/jarvis-routing.v1.json
npm run train:split    -- ai-training/datasets/jarvis-routing.v1.json
npm run train:export   -- ai-training/datasets/jarvis-routing.v1.json --format openai --system "You are ARES, a routing classifier."
```

- **validate** — structure check + duplicate detection + secret/PII scan (exits
  non-zero on any hard credential).
- **sanitize** — writes a redacted copy (`*.sanitized.json`).
- **split** — deterministic train/validation/test (default 0.8/0.1/0.1) by content
  hash, so an example always lands in the same partition.
- **export** — sanitizes implicitly, then writes the chosen format; refuses if a
  credential somehow survives.

## Recommended datasets to build for ARES

Tone/behaviour · intent classification · skill routing · agent routing · tool
routing · code-review format · UI/UX feedback format · marketing-output format ·
writing-cleanup format · personal-assistant behaviours · safety-refusal behaviours ·
Nigerian/Ghanaian business context (where it improves relevance).
