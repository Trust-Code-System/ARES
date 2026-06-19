# GitHub Extraction Report

This is the deliverable the ARES master prompt asks for **first**: a repo-by-repo
inspection of the nine reference repositories, recording what each teaches, what
can be installed, what can be adapted, what to avoid, and **where ARES already
implements the idea** (so we upgrade rather than duplicate).

ARES is already a mature system. For every extracted concept below, the
"ARES status" column points at the existing module or names the genuine gap.
The gaps are tracked at the bottom in **Net-new work**.

> Inspection note: these summaries are based on each repo's documented purpose
> and public structure. They are intentionally about *concepts to adapt into the
> ARES Node/TypeScript stack*, not about vendoring code — most of these repos are
> Python research code under permissive-but-academic licences. Treat them as
> design references, not dependencies. Always re-check the licence before copying
> any source file.

---

## Summary table

| # | Repo | Primary value for ARES | Use as | ARES status |
| --- | --- | --- | --- | --- |
| 1 | openai/following-instructions-human-feedback (InstructGPT) | Instruction-following eval, preference collection, alignment policy | Adapt (eval + feedback) | Partial — agent loop ✅, feedback engine **NEW** |
| 2 | openai/lm-human-preferences | Reward-model concepts, pairwise preference data format | Adapt (preference data) | **NEW** — preference pairs + scoring |
| 3 | openai/summarize-from-feedback | Summary quality eval, faithfulness checks | Adapt (eval) | Partial — summary skills ✅, eval **NEW** |
| 4 | rasbt/LLMs-from-scratch | How transformers/tokenizers/training work | Study only | N/A — education, not production |
| 5 | huggingface/trl | SFT/DPO/reward-model trainers (Python) | Adapt (Python worker) | Partial — SFT export ✅, DPO/worker **NEW** |
| 6 | OpenRLHF/OpenRLHF | Distributed RLHF, Ray, vLLM, async RL | Study / future | Out of scope for v1 |
| 7 | pku-alignment/safe-rlhf | Safety preference data, helpful/harmless split, risk taxonomy | Adapt (safety) | Strong — safety engine ✅, taxonomy upgrade |
| 8 | natolambert/rlhf-book | RLHF/DPO/eval theory and failure modes | Study (playbook) | Partial — AI_TRAINING_STRATEGY.md ✅ |
| 9 | dkyazzentwatwa/chatgpt-skills | Skill folder structure, deterministic tooling, security model | Adapt (skills) | Strong — 400+ skills + loader ✅ |

---

## 1. openai/following-instructions-human-feedback (InstructGPT)

- **Primary purpose:** the InstructGPT line of work — aligning an LLM to follow
  user *intent* via supervised fine-tuning on demonstrations plus RLHF on
  human-ranked outputs.
- **What it teaches:** the three-stage alignment recipe (SFT → reward model →
  RL), the structure of a labeler preference-collection task, and
  instruction-following evaluation against a held-out prompt distribution.
- **Install directly?** No — research code / paper artifacts.
- **Adapt into ARES:**
  - `ares-feedback-service` — capture good/bad responses with a reason
    (see the example in the master prompt). **Net-new** → `src/feedback/`.
  - `ares-instruction-following-benchmark` — eval cases that assert behaviour
    (e.g. "fills form but does not submit"). **Net-new** → evaluation runner.
- **ARES status:** the agent loop (`src/agent/orchestrator.ts`) already does
  intent → context → risk → plan → execute → verify → log. What was missing is
  the *feedback capture* and the *behavioural benchmark*. Both are now tracked.
- **Risk / priority:** low risk, high priority (feedback is the foundation for
  every later training stage).

## 2. openai/lm-human-preferences

- **Primary purpose:** training a reward model from human labels, then
  fine-tuning a policy against it.
- **What it teaches:** the pairwise-comparison data format (`prompt`, `chosen`,
  `rejected`) and ranking-loss intuition — the exact shape DPO needs.
- **Install directly?** No.
- **Adapt into ARES:**
  - `ares-preference-dataset` — a `PreferenceExample { prompt, chosen, rejected,
    reason }` type feeding a DPO export. **Net-new** → `src/ai-training`.
  - `ares-action-ranking` — a rules-based action score (the master prompt's
    `+ asks confirmation … − deletes without confirmation` list) used to *seed*
    preference pairs from the audit log without a human in the loop.
- **ARES status:** the SFT pipeline (`src/ai-training`) handled `input→output`
  only. Preference pairs + DPO export are now added.
- **Risk / priority:** low risk, high priority.

## 3. openai/summarize-from-feedback

- **Primary purpose:** improving summarization with a supervised baseline + a
  reward model trained on human preference between summaries.
- **What it teaches:** how to evaluate *faithfulness* (does the summary invent
  facts?) and how to A/B two summaries and store the preferred one.
- **Install directly?** No.
- **Adapt into ARES:**
  - Summary skills already exist (`skills/.../research-summarizer`,
    `meeting-analyzer`, document tools). The new piece is a **summary feedback
    loop**: present short vs detailed, capture which the user preferred → a
    preference pair (reuses #2's plumbing).
- **ARES status:** summarization ✅; faithfulness eval cases are part of the
  evaluation-runner gap.
- **Risk / priority:** low risk, medium priority.

## 4. rasbt/LLMs-from-scratch

- **Primary purpose:** build/pretrain/fine-tune a GPT-style model from scratch
  for learning.
- **What it teaches:** tokenizer flow, attention, transformer blocks, the
  pretraining/fine-tuning loops, loading pretrained weights.
- **Install directly?** No, and **do not pretrain a model from scratch for
  ARES** — it has no production payoff here.
- **Adapt into ARES:** education only (`docs` notes / a `model-training-lab`
  reference if ever needed). ARES uses hosted models (OpenAI/Anthropic/Gemini)
  and, optionally, local models via Ollama/vLLM.
- **ARES status:** N/A — explicitly study-only per the master prompt.
- **Risk / priority:** n/a.

## 5. huggingface/trl

- **Primary purpose:** practical post-training library — SFT, reward modeling,
  DPO, GRPO, PPO — on top of HF Transformers, with LoRA/PEFT.
- **What it teaches:** the trainer APIs and the dataset shapes each expects
  (chat JSONL for SFT; `{prompt, chosen, rejected}` for DPO).
- **Install directly?** Only inside a dedicated **Python worker** — never in the
  Node app. Heavy deps (torch, transformers, trl).
- **Adapt into ARES:**
  - `workers/python-training-worker` — consumes a job (dataset ref + method) off
    the existing BullMQ queue, runs TRL SFT/DPO on an open-source model, writes a
    versioned adapter to storage. **Net-new** (later tranche).
  - ARES's TS pipeline already produces the datasets TRL needs (now including the
    DPO shape from #2), so the worker is a thin consumer.
- **ARES status:** dataset prep ✅ (`src/ai-training`), training worker is a
  scoped future task. Local fine-tuning is **Stage 6+** of the roadmap — not v1.
- **Risk / priority:** medium risk (GPU/ops), low priority until real preference
  data exists.

## 6. OpenRLHF/OpenRLHF

- **Primary purpose:** high-performance, distributed RLHF using Ray + vLLM +
  DeepSpeed; PPO/DPO at scale, async and agentic RL.
- **What it teaches:** actor/critic/reference-model architecture, rejection
  sampling, multi-GPU launch patterns.
- **Install directly?** No — requires a serious GPU cluster.
- **Adapt into ARES:** **study / far-future only.** Marked "advanced, not needed
  for first production version; only when ARES has enough real preference data."
- **ARES status:** out of scope for v1. Documented so we don't accidentally
  over-build.
- **Risk / priority:** high cost, do-not-start.

## 7. pku-alignment/safe-rlhf

- **Primary purpose:** safety alignment — human labels carrying **both**
  helpfulness and harmlessness preferences, plus a safety reward model.
- **What it teaches:** separating helpfulness from harmlessness, a harm-category
  taxonomy, safe-refusal patterns, privacy-sensitive handling.
- **Install directly?** No (datasets are usable as references with attribution).
- **Adapt into ARES:**
  - The risk taxonomy maps directly onto ARES's existing **safety gate**
    (`src/safety/gate.ts`) and the LOW/MEDIUM/HIGH action table.
  - `safety_label` on preference pairs (chosen-is-safer cases) — added to the
    preference type so safety cases flow into the same training data.
- **ARES status:** **strong** — confirmation gate, standing rules, kill switch,
  spend caps, audit log all exist (migrations 0002–0004, `src/safety/*`,
  `docs/SAFETY_RULES.md`). Upgrade = an explicit harm-category taxonomy doc and
  safety-labelled preference cases.
- **Risk / priority:** low risk, medium priority (mostly already done).

## 8. natolambert/rlhf-book

- **Primary purpose:** a comprehensive written guide to RLHF/post-training.
- **What it teaches:** theory of instruction tuning, reward models, preference
  data design, DPO vs PPO, evaluation methods, common failure modes.
- **Install directly?** No — it's a book.
- **Adapt into ARES:** feeds `docs/AI_TRAINING_STRATEGY.md` (already exists) and a
  `failure-mode-library` section. Use it to justify ARES's "prompts → skills →
  tools → memory → safety **before** any training" ordering.
- **ARES status:** partial — strategy doc exists; the staged Stage-1…Stage-10
  roadmap from the master prompt should be folded in.
- **Risk / priority:** no risk, reference.

## 9. dkyazzentwatwa/chatgpt-skills

- **Primary purpose:** a higher-signal library of agent "skills" with
  deterministic tooling and a clear security model.
- **What it teaches:** the `SKILL.md` pattern, input/output contracts, local
  scripts, dependency management, per-skill permissions and dangerous-action
  declarations.
- **Install directly?** The *pattern* — yes; individual skills — selectively.
- **Adapt into ARES:** already the dominant pattern here.
- **ARES status:** **strong** — 400+ `SKILL.md` files under `skills/`, plus a
  loader/scanner/installer (`src/skills/*`) and usage tracking. Upgrade = ensure
  every skill carries the master prompt's full contract
  (`permissions.json`, `confirmation_required`, `tools_forbidden`).
- **Risk / priority:** low risk, ongoing.

---

## Net-new work (tracked)

Concepts from the repos that ARES genuinely lacked, in priority order:

1. **Feedback engine** (#1, #2) — `feedback` + `preference_pairs` tables, a store,
   a `record_feedback` / `record_preference` tool, and API endpoints. *Built.*
   Plus **action ranking** (`src/feedback/actionRanking.ts`): the gate's real
   decisions are scored against the safety rules and auto-minted into
   `action_ranking` preference pairs at run end — preference data with no human in
   the loop. *Built.*
2. **Preference / DPO dataset support** (#2, #5, #7) — `PreferenceExample` type +
   `{prompt, chosen, rejected}` DPO export feeding TRL. *Built.*
3. **Evaluation runner** (#1, #3) — behavioural eval cases (confirmation required,
   privacy/refusal, tool selection, skill routing, form-filling safety) with a
   deterministic runner. LLM-judged categories (citation, email safety, "don't
   claim unverified actions") are `llm_judge` probes: SKIPPED by default, and
   turned into real pass/fail checks with `npm run eval -- --judge` (uses the
   configured model). *Built — `src/evaluation/`,
   `ai-training/evaluations/ares-behavior.v1.json`.*
4. **Browser-automation / form-filling tool** — Playwright as a real gated tool,
   not just a skill doc. *Built in this tranche — `src/tools/builtin/browser.ts`
   (+ `playwrightController.ts`), `ARES_BROWSER_ENABLED`, the Form Filling skill.
   Never auto-submits, never types secrets, SSRF-guarded.*
5. **Python TRL/OCR workers** (#5) — BullMQ consumers for DPO/SFT training and
   image OCR. *Deferred — Stage 6+ per the master prompt; only once real data/need
   exists, and OCR already works via the vision API.*

Explicitly **not** building: from-scratch pretraining (#4) and distributed
cluster RLHF (#6).
