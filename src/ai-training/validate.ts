/**
 * Dataset validation — structural checks before a dataset is split or exported.
 *
 * Uses the same Zod-first discipline as the tool layer. Validation is separate
 * from sanitization: this confirms the *shape* is right; the sanitizer confirms
 * it carries no secrets. The CLIs run both.
 */

import { z } from 'zod';
import type { Dataset, TrainingExample } from './types.js';
import { scanSecrets, hasCredential } from './sanitizer.js';

export const TrainingExampleSchema = z.object({
  id: z.string().optional(),
  input: z.string().trim().min(1, 'input must be a non-empty string'),
  output: z.union([z.string().trim().min(1, 'output text must be non-empty'), z.record(z.string(), z.unknown())]),
  system: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const DatasetSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  examples: z.array(TrainingExampleSchema),
  meta: z
    .object({
      description: z.string().optional(),
      taskType: z.string().optional(),
      createdAt: z.string().optional(),
      sourceNote: z.string().optional(),
    })
    .optional(),
});

export interface ValidationIssue {
  /** Example index, or -1 for dataset-level issues. */
  index: number;
  level: 'error' | 'warning';
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  total: number;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
}

/** Stringify an example's output for length/duplicate checks. */
export function outputToString(output: TrainingExample['output']): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Validate a dataset's structure, flag duplicates, and surface any example whose
 * text still contains a hard credential (errors) or PII (warnings). Does not
 * mutate — run the sanitizer to actually redact.
 */
export function validateDataset(dataset: Dataset): ValidationReport {
  const issues: ValidationIssue[] = [];

  const parsed = DatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const idx = typeof issue.path[1] === 'number' ? issue.path[1] : -1;
      issues.push({ index: idx, level: 'error', message: `${issue.path.join('.')}: ${issue.message}` });
    }
  }

  const seen = new Map<string, number>();
  dataset.examples.forEach((ex, i) => {
    const key = ex.input.trim().toLowerCase();
    if (seen.has(key)) {
      issues.push({ index: i, level: 'warning', message: `duplicate input (first seen at #${seen.get(key)})` });
    } else {
      seen.set(key, i);
    }

    const text = `${ex.input}\n${outputToString(ex.output)}`;
    const findings = scanSecrets(text);
    if (hasCredential(findings)) {
      issues.push({ index: i, level: 'error', message: `contains a credential (${findings.map((f) => f.kind).join(', ')}) — sanitize before export` });
    } else if (findings.length) {
      issues.push({ index: i, level: 'warning', message: `contains PII (${findings.map((f) => f.kind).join(', ')}) — will be redacted on sanitize` });
    }
  });

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  return { ok: errors === 0, total: dataset.examples.length, errors, warnings, issues };
}
