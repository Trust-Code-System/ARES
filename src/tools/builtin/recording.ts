/**
 * analyze_transcript — turn a meeting/voice-note transcript into action.
 *
 * ARES's analog to "Record Mode": the audio-capture and speech-to-text already
 * exist (the voice endpoints / desktop client), so the missing piece is turning
 * a raw transcript into structured, actionable output — a summary, decisions,
 * action items with suggested owners and due dates, and open questions. This
 * tool produces that structured brief; ARES can then follow up with create_task
 * for each action item and remember_memory for durable decisions (those stay
 * separately gated — this read-only step never mutates anything itself).
 */

import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import type { Synthesizer } from '../../llm/synthesize.js';

const SYSTEM =
  'You process meeting and voice-note transcripts into a concise, actionable brief. ' +
  'Use ONLY what the transcript supports — never invent decisions, owners, or dates. ' +
  'Output markdown with these sections, omitting any that have no content:\n' +
  '## Summary — 2-4 sentences.\n' +
  '## Key decisions — bullet list.\n' +
  '## Action items — bullet list; for each give the task, a suggested owner if named, ' +
  'and a due date if stated or clearly implied (else "no date").\n' +
  '## Open questions — anything unresolved.\n' +
  'If the transcript is too sparse to extract anything, say so plainly.';

export function createRecordingTool(synthesize: Synthesizer): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'analyze_transcript',
    description:
      'Summarize a meeting/voice-note transcript and extract decisions, action items ' +
      '(with suggested owners and due dates), and open questions. Use after a recording ' +
      'is transcribed. Follow up with create_task for action items and remember_memory ' +
      'for durable decisions when the user wants them saved.',
    kind: 'read_only',
    schema: z.object({
      transcript: z.string().min(1).describe('The transcribed text of the meeting or voice note.'),
      context: z
        .string()
        .describe('Optional context: who attended, the meeting purpose, the project, etc.')
        .optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const user = input.context
        ? `Context: ${input.context}\n\nTranscript:\n${input.transcript}`
        : `Transcript:\n${input.transcript}`;
      const brief = await synthesize(SYSTEM, user, {
        tier: 'reasoning',
        maxTokens: 2000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      ctx.logger.info('transcript analyzed', { chars: input.transcript.length });
      return { ok: true, content: brief || '(no brief could be produced from this transcript)' };
    },
  });
}
