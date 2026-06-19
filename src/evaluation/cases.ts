/**
 * Eval-case loading + validation.
 *
 * Cases live as JSON under ai-training/evaluations/ so they are versioned and
 * reviewable alongside datasets. This validates them with Zod before the runner
 * sees them, so a malformed case fails loudly instead of silently passing.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { EVAL_CATEGORIES, type EvalCase } from './types.js';

const probeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool_gating'), tool: z.string(), requiresConfirmation: z.boolean() }),
  z.object({ type: z.literal('tool_presence'), tool: z.string(), registered: z.boolean() }),
  z.object({ type: z.literal('privacy'), input: z.unknown(), blocked: z.boolean() }),
  z.object({ type: z.literal('skill_routing'), request: z.string(), expectMatch: z.string(), topK: z.number().int().positive().optional() }),
  z.object({ type: z.literal('llm_judge'), input: z.string(), expect: z.string() }),
]);

const caseSchema = z.object({
  name: z.string().min(1),
  category: z.enum(EVAL_CATEGORIES),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  probe: probeSchema,
});

export const evalSuiteSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  cases: z.array(caseSchema),
});

/** Parse + validate an array of cases from an unknown value (e.g. parsed JSON). */
export function parseCases(value: unknown): EvalCase[] {
  return evalSuiteSchema.parse(value).cases as EvalCase[];
}

/** Read and validate an eval suite JSON file. */
export function loadCasesFromFile(filePath: string): EvalCase[] {
  return parseCases(JSON.parse(readFileSync(filePath, 'utf8')));
}
