/**
 * Dataset exporters.
 *
 * OpenAI chat JSONL is the primary, runnable target (you already have the key +
 * SDK). The verified-current Gemini path is Vertex AI supervised tuning, which
 * uses its OWN JSONL `contents` shape and requires a GCP project — see
 * docs/AI_TRAINING_STRATEGY.md. We emit the OpenAI format here and the generic
 * JSONL/CSV forms for inspection and for other tools.
 */

import type { Dataset, PreferenceDataset, TrainingExample } from './types.js';
import { outputToString } from './validate.js';

/** Raw JSONL: one example object per line (for inspection / re-import). */
export function toJsonl(examples: readonly TrainingExample[]): string {
  return examples.map((ex) => JSON.stringify(ex)).join('\n');
}

export interface OpenAIExportOptions {
  /**
   * System prompt for examples lacking their own `system`. Recommended for tone
   * datasets so training matches inference. Optional for pure I/O routing sets.
   */
  defaultSystem?: string;
}

/**
 * OpenAI fine-tuning chat format: one `{ "messages": [...] }` object per line.
 * Object outputs are serialized to compact JSON so the model learns to emit
 * valid structured output.
 */
export function toOpenAIChatJsonl(dataset: Dataset, opts: OpenAIExportOptions = {}): string {
  return dataset.examples
    .map((ex) => {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      const system = ex.system ?? opts.defaultSystem;
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: ex.input });
      messages.push({ role: 'assistant', content: outputToString(ex.output) });
      return JSON.stringify({ messages });
    })
    .join('\n');
}

/**
 * DPO preference JSONL: one `{ "prompt", "chosen", "rejected" }` object per line.
 * This is the shape TRL's DPOTrainer and most preference-tuning tooling expect
 * (see docs/github-extraction-report.md, repo #5). The optional system prompt is
 * prepended to the prompt as a chat turn pair when present, matching the SFT
 * export's convention; `reason`/`safetyLabel` are review metadata and are
 * intentionally omitted from the training record.
 */
export function toDpoJsonl(
  dataset: PreferenceDataset,
  opts: OpenAIExportOptions = {},
): string {
  return dataset.examples
    .map((ex) => {
      const system = ex.system ?? opts.defaultSystem;
      const prompt = system ? `${system}\n\n${ex.prompt}` : ex.prompt;
      return JSON.stringify({ prompt, chosen: ex.chosen, rejected: ex.rejected });
    })
    .join('\n');
}

/** Escape a CSV field per RFC 4180 (quote if it contains comma/quote/newline). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Two-column CSV (input,output) — output objects are JSON-stringified. */
export function toCsv(examples: readonly TrainingExample[]): string {
  const rows = ['input,output'];
  for (const ex of examples) {
    rows.push(`${csvField(ex.input)},${csvField(outputToString(ex.output))}`);
  }
  return rows.join('\n');
}
