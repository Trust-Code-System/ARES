/**
 * Feedback tools: record_feedback, record_preference.
 *
 * These let ARES capture the principal's signal on its own output — a thumbs
 * up/down with an optional correction, or an explicit "this answer beats that
 * one" preference pair. The signal is the raw material for the improvement loop
 * (see docs/github-extraction-report.md): corrections and A/B choices become
 * {prompt, chosen, rejected} preference pairs that the DPO export later consumes.
 *
 * Both mutate durable state, so — consistent with create_task/remember_memory —
 * they are `state_mutating` and pass through the confirmation gate. A standing
 * rule can pre-authorize them for frictionless capture. The store never trains
 * anything; sanitization/consent is enforced at export time in src/ai-training.
 *
 * Built via a factory because they close over the feedback store.
 */

import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { FEEDBACK_TARGETS, SAFETY_LABELS, type FeedbackStore } from '../../feedback/store.js';

export function createFeedbackTools(store: FeedbackStore): Tool[] {
  const recordFeedback = defineTool({
    name: 'record_feedback',
    description:
      "Record the principal's feedback on a response or action — a rating (up/down/neutral), " +
      'a note, and optionally the corrected wording they would have preferred. Use when the ' +
      'user expresses approval, disapproval, or a correction. A correction is automatically ' +
      'turned into a preference pair for future training. Mutates durable state, so it is gated.',
    kind: 'state_mutating',
    schema: z.object({
      rating: z
        .union([z.literal(-1), z.literal(0), z.literal(1)])
        .describe('-1 = thumbs down, 0 = neutral/comment, +1 = thumbs up.'),
      target: z.enum(FEEDBACK_TARGETS).describe('What the feedback is about. Defaults to "response".').optional(),
      note: z.string().describe('Free-text feedback from the user.').optional(),
      correction: z.string().describe('The wording the user would have preferred, if they gave one.').optional(),
      prompt: z.string().describe('The input that produced the rated output (enables pairing).').optional(),
      response: z.string().describe('The response/action being rated.').optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const fb = await store.record({
        rating: input.rating,
        ...(input.target ? { target: input.target } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.correction !== undefined ? { correction: input.correction } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.response !== undefined ? { response: input.response } : {}),
        runId: ctx.runId,
      });

      // A correction with both sides present is a ready-made preference pair:
      // the correction is preferred over what ARES actually said.
      let pairedNote = '';
      if (input.correction && input.prompt && input.response) {
        await store.addPreference({
          prompt: input.prompt,
          chosen: input.correction,
          rejected: input.response,
          reason: input.note ?? 'User correction',
          source: 'correction',
        });
        pairedNote = ' Logged a preference pair from the correction.';
      }

      return { ok: true, content: `Recorded feedback (rating ${fb.rating}).${pairedNote}`, data: { id: fb.id } };
    },
  });

  const recordPreference = defineTool({
    name: 'record_preference',
    description:
      'Record an explicit preference between two candidate responses for the same prompt ' +
      '(chosen is better than rejected). Use after an A/B comparison, e.g. short vs detailed ' +
      'summary. Becomes training-ready DPO data. Mutates durable state, so it is gated.',
    kind: 'state_mutating',
    schema: z.object({
      prompt: z.string().describe('The shared input both candidates answered.'),
      chosen: z.string().describe('The preferred response.'),
      rejected: z.string().describe('The rejected response.'),
      reason: z.string().describe('Why chosen is better.').optional(),
      safety_label: z
        .enum(SAFETY_LABELS)
        .describe('Set when this is a safety case (e.g. "unsafe_rejected").')
        .optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const pair = await store.addPreference({
        prompt: input.prompt,
        chosen: input.chosen,
        rejected: input.rejected,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.safety_label ? { safetyLabel: input.safety_label } : {}),
        source: 'ab_choice',
      });
      return { ok: true, content: `Recorded preference pair (id ${pair.id}).`, data: { id: pair.id } };
    },
  });

  return [recordFeedback, recordPreference];
}
