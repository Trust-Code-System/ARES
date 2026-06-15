# AI Training Strategy

**The short version: ARES should rarely fine-tune.** It already has skills (expert
workflows), memory (preferences/context), RAG (knowledge via pgvector), tools
(actions), and a model router. Fine-tuning is the *last* lever, not the first.

## The decision guide

Map each need to the cheapest mechanism that satisfies it:

| Need | Use | Not |
|------|-----|-----|
| Answer from documents/knowledge that changes | **RAG** (memory retriever) | fine-tuning (bakes in stale facts) |
| Expert workflow / domain procedure | **Skills** (`find_skill`/`use_skill`) | fine-tuning |
| User preferences, project context | **Memory** | fine-tuning |
| Take an action (email, file, deploy) | **Tools** | fine-tuning |
| One-off behavior change | **Prompt engineering** | fine-tuning |
| **Repeated** output pattern, classification, routing, tone, structured format | **Fine-tuning** (after prompting plateaus) | RAG |

Rule of thumb: if new information should change the answer, it belongs in RAG or
memory. If a *consistent way of responding* should change, that's the fine-tuning
candidate — and only once prompting + examples stop improving it.

## What to fine-tune (good candidates)

- Intent classification / agent / skill / tool **routing** (structured output).
- ARES **tone & behaviour** (concise, decisive voice).
- Strict **output formats** (e.g. code-review format, marketing-copy format).
- **Safety refusal** style (consistent, calm refusals).

## What NOT to fine-tune

- Knowledge/facts (use RAG) · user data/preferences (use memory) · actions (tools)
- Anything you have < ~100 clean examples for.
- Anything containing secrets or unconsented private user data (**never**).

## Provider reality (verified June 2026)

| Path | Status | Notes |
|------|--------|-------|
| **OpenAI SFT** | ✅ recommended first target | You already have the key + SDK. JSONL chat format (`messages`). Runnable today. |
| **Gemini via Vertex AI** | ⚠️ optional, heavier | Fine-tuning **moved off AI Studio / the Gemini API** to **Vertex AI (Gemini Enterprise Agent Platform)**. JSONL, ~100+ examples, **paid** (tuned endpoints ≈ 1.5× base price), needs a **GCP project**. |
| **Gemini 3.x tuning** | ❌ not available | SFT supports Gemini 2.5/2.0 only; 3.x (ARES's default) is **not tunable** yet. |
| Google **AI Studio CSV/XLSX UI tuning** | ❌ outdated | The old `input,output` CSV / Gemini 1.0 Pro flow (e.g. the ruvnet gist) no longer reflects reality — do **not** implement it. |

So: build datasets with `src/ai-training`, export **OpenAI JSONL** first. Treat Vertex
as a documented option, not a default.

Sources: [Gemini API model-tuning](https://ai.google.dev/gemini-api/docs/model-tuning),
[Vertex supervised tuning — prepare data](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/supervised-tuning/prepare-data),
[Gemini 3.x tuning not yet available](https://discuss.google.dev/t/when-will-supervised-fine-tuning-be-available-for-gemini-3-x-models-on-vertex-ai/346487).

## Evaluate before AND after

Never tune blind. The `fine-tuning` workflow enforces this:

1. Build a **held-out** eval set (no overlap with training — the deterministic split
   in `src/ai-training/dataset.ts` guarantees this).
2. Measure a **baseline** on the current model.
3. Tune; measure the **tuned** model on the same eval set.
4. Ship only if the tuned model beats the baseline on the real metric.

Mirror the project's deterministic harness (`tests/routing.eval.test.ts`).

## Preventing overfitting

- Keep the eval set held out; never tune the eval set to flatter a change.
- Start small (≈100 examples), few epochs; add data before adding epochs.
- Watch for the tuned model regressing on cases outside the training distribution.

## Versioning & rollback

- Datasets are versioned files: `name.v<major>.json`. Bump + keep the old file.
- Record each tuning run in [`ai-training/adapters`](../ai-training/adapters):
  dataset version, provider, base model, job id, tuned model id, eval delta, date.
- **Rollback = point the `ARES_*_MODEL` env var back at the previous id** (or the
  base model). No code change — the model factory/router picks it up.

## Pipeline

```
prepare → validate (npm run train:validate) → sanitize (train:sanitize)
        → split (train:split) → export (train:export --format openai)
```

See [`DATASET_FORMAT.md`](./DATASET_FORMAT.md) and [`SAFETY_RULES.md`](./SAFETY_RULES.md).
