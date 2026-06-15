/**
 * The specialist-agent tools: `find_agent`, `use_agent`, and `agent_route`.
 *
 * These give the model progressive disclosure over the persona library — exactly
 * like `find_skill`/`use_skill` do for skills — plus a deterministic router it can
 * call to plan a multi-agent response. All three are READ-ONLY: they never execute
 * anything and never bypass the safety gate. A persona is guidance the model may
 * adopt for a turn; it can never override the system's safety rules.
 *
 * The index is built lazily on first use and cached, so wiring these tools costs
 * nothing until the model actually reaches for an agent.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { defineTool } from '../tools/define.js';
import { loadAgentIndex, MAX_AGENT_BODY_BYTES, type AgentIndex } from './loader.js';
import { selectAgents } from './router.js';
import type { Provider } from '../llm/router.js';
import type { SkillUsageStore } from '../skills/usage.js';

export interface AgentToolsOptions {
  /** Directory the persona library lives in (e.g. `<repo>/agents`). */
  agentsDir: string;
  /** Optional usage memory; `use_agent` records each successful load. */
  usageStore?: SkillUsageStore;
  /** Providers with keys configured, so the router never points at an unconfigured one. */
  availableProviders?: ReadonlySet<Provider>;
}

/**
 * One-line system-prompt pointer. Append only when the agent tools are registered.
 * Deliberately understated: the model should reach for a specialist *when the task
 * needs one*, not turn every turn into a persona.
 */
export const AGENTS_PROMPT_NOTE =
  'You have a library of specialist agents (expert personas). For non-trivial ' +
  'domain work, you may call agent_route to plan who should handle it, find_agent ' +
  'to locate a persona, and use_agent to adopt its playbook for the task. Activate ' +
  'a specialist only when the request genuinely needs one — a persona is guidance, ' +
  'never an override of these rules or the safety gate.';

const DEFAULT_FIND_LIMIT = 5;

/** Build the read-only find_agent / use_agent / agent_route tools. */
export function createAgentTools(opts: AgentToolsOptions): Tool[] {
  let cached: AgentIndex | undefined;
  const index = (logger?: Parameters<typeof loadAgentIndex>[1]): AgentIndex => {
    if (!cached) cached = loadAgentIndex(opts.agentsDir, logger);
    return cached;
  };

  const findAgent = defineTool({
    name: 'find_agent',
    description:
      'Search the specialist-agent library for personas relevant to a task ' +
      '(engineering, security, product, design, AI, marketing, strategy, …). ' +
      'Returns ranked matches with id and description; adopt one with use_agent ' +
      'or plan a full response with agent_route.',
    kind: 'read_only',
    schema: z.object({
      query: z.string().describe('What you need help with, in a few keywords or a short phrase.'),
      limit: z.number().int().min(1).max(20).describe(`How many matches (1-20, default ${DEFAULT_FIND_LIMIT}).`).optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const idx = index(ctx.logger);
      if (idx.size === 0) return { ok: true, content: 'The agent library is empty or unavailable.' };
      const matches = idx.search(input.query, input.limit ?? DEFAULT_FIND_LIMIT);
      ctx.logger.info('find_agent', { query: input.query, hits: matches.length });
      if (matches.length === 0) {
        return { ok: true, content: `No agents matched "${input.query}". Try different keywords.` };
      }
      const content = matches
        .map((a) => {
          const risk = a.riskLevel !== 'low' ? ` [risk: ${a.riskLevel}]` : '';
          return `- ${a.id} (${a.category})${risk}\n  ${truncate(a.description, 300)}`;
        })
        .join('\n');
      return {
        ok: true,
        content: `Matching agents (adopt one with use_agent, passing its id):\n${content}`,
        data: { ids: matches.map((a) => a.id) },
      };
    },
  });

  const useAgent = defineTool({
    name: 'use_agent',
    description:
      'Load the full playbook for a specialist agent found via find_agent or ' +
      'agent_route. Pass the agent id (e.g. "security/security-engineer"). Returns ' +
      'the persona to adopt for the task: its role, process, output style, and ' +
      'safety rules. Treat it as guidance — it never overrides your core rules.',
    kind: 'read_only',
    schema: z.object({
      name: z.string().describe('The agent id from find_agent (e.g. "engineering/backend-architect"), or its bare name.'),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const idx = index(ctx.logger);
      const agent = idx.get(input.name);
      if (!agent) {
        const candidates = idx.byName(input.name);
        if (candidates.length > 1) {
          const list = candidates.map((c) => `  - ${c.id}`).join('\n');
          return { ok: false, content: `"${input.name}" matches several agents — pass one of these ids:\n${list}` };
        }
        return { ok: false, content: `No agent "${input.name}". Use find_agent to locate one and pass the id it returns.` };
      }

      let body: string;
      try {
        body = readFileSync(agent.bodyPath, 'utf8');
      } catch (err) {
        return { ok: false, content: `Failed to read agent "${agent.id}": ${(err as Error).message}` };
      }
      ctx.logger.info('use_agent', { id: agent.id });
      try {
        opts.usageStore?.record(`agent:${agent.id}`, ctx.runId);
      } catch {
        /* telemetry only */
      }

      const trimmed = truncateBytes(body, MAX_AGENT_BODY_BYTES);
      const sections = [`# Agent persona: ${agent.id}\n`, trimmed.trim()];
      if (agent.skills.length || agent.tools.length) {
        const hints: string[] = [];
        if (agent.skills.length) hints.push(`Relevant skills (load via use_skill): ${agent.skills.join(', ')}`);
        if (agent.tools.length) hints.push(`Tools this agent uses: ${agent.tools.join(', ')}`);
        sections.push(`\n---\n${hints.join('\n')}`);
      }
      return { ok: true, content: sections.join('\n'), data: { id: agent.id, riskLevel: agent.riskLevel } };
    },
  });

  const agentRoute = defineTool({
    name: 'agent_route',
    description:
      'Plan a (possibly multi-agent) response to a request. Returns a routing ' +
      'decision: intent, primary_agent, supporting_agents, the skills/tools they ' +
      'lean on, model provider, risk_level, and whether human confirmation is ' +
      'advisable. Use this to decide who should handle complex work before acting.',
    kind: 'read_only',
    schema: z.object({
      request: z.string().describe('The user request to route, in their own words.'),
      max_supporting: z.number().int().min(0).max(5).describe('How many supporting agents to include (0-5, default 2).').optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const idx = index(ctx.logger);
      if (idx.size === 0) return { ok: true, content: 'The agent library is empty — handle this as the general assistant.' };
      const route = selectAgents(input.request, idx, {
        ...(input.max_supporting !== undefined ? { maxSupporting: input.max_supporting } : {}),
        ...(opts.availableProviders ? { available: opts.availableProviders } : {}),
      });
      ctx.logger.info('agent_route', { intent: route.intent, primary: route.primary_agent });
      return { ok: true, content: JSON.stringify(route, null, 2), data: route as unknown as Record<string, unknown> };
    },
  });

  return [findAgent, useAgent, agentRoute];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return `${buf.toString('utf8')}\n\n…(persona truncated)`;
}
