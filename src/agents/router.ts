/**
 * Agent router (Phase 7) — deterministic, offline, pure.
 *
 * Given a user request and the loaded persona index, decide which specialist(s)
 * should handle it: a primary agent, supporting agents, the skills/tools they
 * lean on, the model provider, the risk level, and whether a human confirmation
 * is warranted. Like {@link selectRoute} for models, this is a *pure function* so
 * it can be unit-tested with no network or model calls — it is the regression
 * backbone for agent selection.
 *
 * It does NOT replace the safety gate: `needs_confirmation` is advisory routing
 * metadata. Irreversible tool calls are still gated at execution time regardless
 * of what the router says. And it deliberately reuses {@link selectRoute} for the
 * model decision rather than re-implementing provider policy.
 */

import type { AgentIndex, AgentRecord } from './loader.js';
import type { RiskLevel } from '../skills/loader.js';
import { selectRoute, type Provider, type TaskKind } from '../llm/router.js';

export interface AgentRoute {
  /** Coarse, deterministic intent label, e.g. "review:security". */
  intent: string;
  /** Best-matched agent id, or null when nothing matched (caller falls back to general). */
  primary_agent: string | null;
  /** Other agents that should contribute, in rank order. */
  supporting_agents: string[];
  /** Union of skills the selected agents lean on (routing hints for find_skill). */
  skills: string[];
  /** Union of tools the selected agents expect. */
  tools: string[];
  /** Model provider chosen via the existing model-router policy. */
  model: Provider;
  /** Highest risk across the selected agents. */
  risk_level: RiskLevel;
  /** Advisory: should a human confirm before acting? (gate still enforces at runtime) */
  needs_confirmation: boolean;
  /** Why this route was chosen (logged / surfaced in evals). */
  reason: string;
}

export interface SelectAgentsOptions {
  /** How many supporting agents to include (default 2). */
  maxSupporting?: number;
  /** Providers with keys configured; defaults to all three. */
  available?: ReadonlySet<Provider>;
  /** Fallback order; defaults to anthropic-led. */
  order?: readonly Provider[];
}

const DEFAULT_AVAILABLE: ReadonlySet<Provider> = new Set<Provider>(['anthropic', 'openai', 'gemini']);
const DEFAULT_ORDER: readonly Provider[] = ['anthropic', 'openai', 'gemini'];

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Action verbs we can detect in a request, mapped to the intent prefix. */
const VERBS: Array<[RegExp, string]> = [
  [/\b(review|audit|check|assess|evaluate)\b/i, 'review'],
  [/\b(build|create|implement|add|develop|ship)\b/i, 'build'],
  [/\b(design|mock\s?up|wireframe|prototype)\b/i, 'design'],
  [/\b(fix|debug|repair|resolve)\b/i, 'fix'],
  [/\b(refactor|clean\s?up|simplify|restructure)\b/i, 'refactor'],
  [/\b(improve|enhance|polish|upgrade|optimi[sz]e)\b/i, 'improve'],
  [/\b(write|draft|rewrite|copy|caption|headline)\b/i, 'write'],
  [/\b(plan|scope|prioriti[sz]e|roadmap|spec)\b/i, 'plan'],
  [/\b(test|qa|cover|verify)\b/i, 'test'],
  [/\b(secure|harden|pentest|threat)\b/i, 'secure'],
];

/** Map an agent's category/id to a model-router TaskKind. */
export function agentTaskKind(agent: AgentRecord): TaskKind {
  if (/architect/i.test(agent.id) || agent.category === 'ai') return 'architecture';
  if (agent.category === 'engineering' || agent.category === 'security' || agent.category === 'testing') {
    return 'code';
  }
  if (agent.category === 'marketing') return 'writing';
  return 'general';
}

function detectVerb(text: string): string {
  for (const [re, label] of VERBS) if (re.test(text)) return label;
  return 'assist';
}

/**
 * Pure routing decision. Returns a fully-populated {@link AgentRoute}; when no
 * persona matches, `primary_agent` is null and the caller should fall back to the
 * general assistant.
 */
export function selectAgents(
  text: string,
  index: AgentIndex,
  opts: SelectAgentsOptions = {},
): AgentRoute {
  const maxSupporting = opts.maxSupporting ?? 2;
  const available = opts.available ?? DEFAULT_AVAILABLE;
  const order = opts.order ?? DEFAULT_ORDER;
  const verb = detectVerb(text);

  // Search a little wider than we keep, so we have supporting candidates.
  const hits = index.search(text, maxSupporting + 1 + 2);
  const primary = hits[0];

  if (!primary) {
    return {
      intent: `${verb}:general`,
      primary_agent: null,
      supporting_agents: [],
      skills: [],
      tools: [],
      model: selectRoute({ kind: 'general' }, available, order).provider,
      risk_level: 'low',
      needs_confirmation: false,
      reason: 'no specialist matched — general assistant handles it',
    };
  }

  const supporting = hits.slice(1, 1 + maxSupporting);
  const selected = [primary, ...supporting];

  const skills = [...new Set(selected.flatMap((a) => a.skills))];
  const tools = [...new Set(selected.flatMap((a) => a.tools))];

  let risk: RiskLevel = 'low';
  for (const a of selected) if (RISK_RANK[a.riskLevel] > RISK_RANK[risk]) risk = a.riskLevel;

  const model = selectRoute({ kind: agentTaskKind(primary) }, available, order).provider;

  return {
    intent: `${verb}:${primary.category}`,
    primary_agent: primary.id,
    supporting_agents: supporting.map((a) => a.id),
    skills,
    tools,
    model,
    risk_level: risk,
    needs_confirmation: risk !== 'low',
    reason:
      `matched "${primary.name}" (${primary.category})` +
      (supporting.length ? `, supported by ${supporting.map((a) => a.name).join(', ')}` : ''),
  };
}
