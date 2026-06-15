/**
 * The skill-library tools: `find_skill` and `use_skill`.
 *
 * Together they implement progressive disclosure over a large vendored library
 * of expert playbooks (see {@link loadSkillIndex}). `find_skill` searches the
 * catalog so only relevant skills enter the context; `use_skill` then loads one
 * skill's full playbook on demand. Both are read-only — they never execute
 * anything. A skill's bundled Python scripts are surfaced as paths and run only
 * through the gated, audited `run_python` tool.
 *
 * The index is built lazily on first use and cached, so wiring these tools costs
 * nothing until the model actually reaches for a skill.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { defineTool } from '../tools/define.js';
import { loadSkillIndex, MAX_SKILL_BODY_BYTES, type SkillIndex } from './loader.js';
import type { SkillUsageStore } from './usage.js';

export interface SkillToolsOptions {
  /** Directory the skill library was vendored into (e.g. `<repo>/skills`). */
  skillsDir: string;
  /** Optional skill-usage memory; `use_skill` records each successful load. */
  usageStore?: SkillUsageStore;
}

/**
 * One-line system-prompt pointer telling the model the skill library exists.
 * Append to a system prompt only when the skill tools are actually registered.
 */
export const SKILLS_PROMPT_NOTE =
  'You have a large library of expert skills (domain playbooks). When a task ' +
  'could benefit from specialized expertise, call find_skill to locate a relevant ' +
  'one, then use_skill to load its playbook and follow it.';

const DEFAULT_FIND_LIMIT = 5;

/** Build the read-only `find_skill` + `use_skill` tools over a vendored library. */
export function createSkillTools(opts: SkillToolsOptions): Tool[] {
  let cached: SkillIndex | undefined;
  const index = (logger?: Parameters<typeof loadSkillIndex>[1]): SkillIndex => {
    if (!cached) cached = loadSkillIndex(opts.skillsDir, logger);
    return cached;
  };

  const findSkill = defineTool({
    name: 'find_skill',
    description:
      'Search the expert skill library for a playbook relevant to the task. ' +
      'Call this proactively whenever a request could benefit from specialized ' +
      'domain expertise (engineering, product, marketing, finance, research, ' +
      'compliance, leadership, operations, …) before answering from general ' +
      'knowledge. Returns ranked matches with their id and description; load one ' +
      'with use_skill.',
    kind: 'read_only',
    schema: z.object({
      query: z.string().describe('What you need help with, in a few keywords or a short phrase.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .describe(`How many matches to return (1-20, default ${DEFAULT_FIND_LIMIT}).`)
        .optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const idx = index(ctx.logger);
      if (idx.size === 0) {
        return { ok: true, content: 'The skill library is empty or unavailable.' };
      }
      const limit = input.limit ?? DEFAULT_FIND_LIMIT;
      const matches = idx.search(input.query, limit);
      ctx.logger.info('find_skill', { query: input.query, hits: matches.length });
      if (matches.length === 0) {
        return { ok: true, content: `No skills matched "${input.query}". Try different keywords.` };
      }
      const content = matches
        .map((m) => {
          const scripts = m.scripts.length > 0 ? ` [${m.scripts.length} script(s)]` : '';
          // Surface a risk tag only when above the default so the common case stays terse.
          const risk = m.riskLevel !== 'low' ? ` [risk: ${m.riskLevel}]` : '';
          return `- ${m.id}${scripts}${risk}\n  ${truncate(m.description, 400)}`;
        })
        .join('\n');
      return {
        ok: true,
        content: `Matching skills (load one with use_skill, passing its id):\n${content}`,
        data: { ids: matches.map((m) => m.id) },
      };
    },
  });

  const useSkill = defineTool({
    name: 'use_skill',
    description:
      'Load the full playbook for a skill found via find_skill. Pass the skill id ' +
      '(e.g. "engineering/llm-cost-optimizer") or its name if unambiguous. Returns ' +
      'the playbook to follow for the task, plus the paths of any bundled scripts ' +
      '(run those only via run_python, which is gated).',
    kind: 'read_only',
    schema: z.object({
      name: z.string().describe('The skill id from find_skill (e.g. "engineering/llm-cost-optimizer"), or its bare name.'),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const idx = index(ctx.logger);
      const skill = idx.get(input.name);
      if (!skill) {
        const candidates = idx.byName(input.name);
        if (candidates.length > 1) {
          const list = candidates.map((c) => `  - ${c.id}`).join('\n');
          return {
            ok: false,
            content: `"${input.name}" matches several skills — pass one of these ids:\n${list}`,
          };
        }
        return {
          ok: false,
          content: `No skill "${input.name}". Use find_skill to locate one and pass the id it returns.`,
        };
      }

      let body: string;
      try {
        body = readFileSync(skill.bodyPath, 'utf8');
      } catch (err) {
        return { ok: false, content: `Failed to read skill "${skill.id}": ${(err as Error).message}` };
      }
      ctx.logger.info('use_skill', { id: skill.id, scripts: skill.scripts.length });
      // Record into skill-usage memory (best-effort; never fails the load).
      try {
        opts.usageStore?.record(skill.id, ctx.runId);
      } catch {
        /* telemetry only */
      }

      const trimmedBody = truncateBytes(body, MAX_SKILL_BODY_BYTES);
      const sections = [`# Skill: ${skill.id}\n`, trimmedBody.trim()];
      if (skill.scripts.length > 0) {
        const scriptList = skill.scripts.map((p) => `- ${p}`).join('\n');
        sections.push(
          `\n---\nBundled scripts for this skill:\n${scriptList}\n\n` +
            'To run one, call run_python (it is confirmation-gated and audited) and ' +
            'execute the file at its absolute path — do not run anything automatically.',
        );
      }
      return { ok: true, content: sections.join('\n'), data: { id: skill.id, scripts: skill.scripts } };
    },
  });

  return [findSkill, useSkill];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Trim to a byte budget without splitting a multi-byte char.
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return `${buf.toString('utf8')}\n\n…(playbook truncated)`;
}
