/**
 * Specialist-agent library loader.
 *
 * An "agent" is a vendored persona: an `agent.md` playbook (markdown body +
 * YAML frontmatter with `name`/`description`) plus a richer `metadata.json`
 * sidecar (category, trigger_keywords, skills, tools, risk_level, source_repo)
 * and an optional `examples.md`. Personas live under `agents/<category>/<id>/`.
 *
 * This mirrors {@link loadSkillIndex} deliberately: agents are the same shape as
 * skills (markdown + metadata), so this reuses the skill frontmatter parser and
 * the same "never throw, skip bad entries" loading discipline rather than forking
 * a second mechanism. The difference is intent — skills are *playbooks the model
 * follows*; agents are *personas the router activates on demand*, carrying explicit
 * routing metadata (triggers, supporting skills/tools, risk).
 *
 * Loading is filesystem-only; no agent code is executed here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import { parseFrontmatter, type RiskLevel } from '../skills/loader.js';

/** Max bytes of an agent.md body returned to the model (keeps context bounded). */
export const MAX_AGENT_BODY_BYTES = 32 * 1024;

/**
 * `metadata.json` sidecar next to an agent.md. Matches the schema in the project
 * brief. Every field is optional; the loader falls back to frontmatter /
 * path-derived values, so a persona with only an agent.md still loads.
 */
export interface AgentMetadata {
  id?: string;
  name?: string;
  category?: string;
  description?: string;
  /** Upstream repo the persona was vendored from (provenance / audit). */
  source_repo?: string;
  /** Keywords that should route a request to this agent. */
  trigger_keywords?: string[];
  /** Skill ids this agent's process leans on (boosts skill routing). */
  skills?: string[];
  /** Tools this agent's process expects to be available. */
  tools?: string[];
  /** Coarse risk grade — drives the router's needs_confirmation heuristic. */
  risk_level?: RiskLevel;
  /** When false, the agent is excluded from the index entirely. */
  enabled?: boolean;
}

export interface AgentRecord {
  /** Stable unique key: metadata `id` or `<category>/<name>`. */
  id: string;
  name: string;
  /** First path segment under the agents root, or metadata `category`. */
  category: string;
  description: string;
  /** Absolute path to the agent's directory. */
  dir: string;
  /** Absolute path to the agent.md file. */
  bodyPath: string;
  /** Absolute path to examples.md, when present. */
  examplesPath?: string;
  riskLevel: RiskLevel;
  triggerKeywords: string[];
  skills: string[];
  tools: string[];
  sourceRepo?: string;
}

export interface AgentIndex {
  readonly all: readonly AgentRecord[];
  readonly size: number;
  /** Exact lookup by `id` or, if unambiguous, by bare `name`. */
  get(idOrName: string): AgentRecord | undefined;
  byName(name: string): AgentRecord[];
  /** Ranked keyword search over name + description + triggers; best first. */
  search(query: string, limit: number): AgentRecord[];
}

/** Read and validate an optional `metadata.json`. Bad files yield `undefined`. */
export function readAgentMetadata(dir: string): AgentMetadata | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, 'metadata.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const m = parsed as Record<string, unknown>;

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : undefined;
  const risk = (v: unknown): RiskLevel | undefined =>
    v === 'low' || v === 'medium' || v === 'high' ? v : undefined;

  const out: AgentMetadata = {};
  const id = str(m.id);
  if (id) out.id = id;
  const name = str(m.name);
  if (name) out.name = name;
  const category = str(m.category);
  if (category) out.category = category;
  const description = str(m.description);
  if (description) out.description = description;
  const sourceRepo = str(m.source_repo);
  if (sourceRepo) out.source_repo = sourceRepo;
  const triggers = strArr(m.trigger_keywords);
  if (triggers) out.trigger_keywords = triggers;
  const skills = strArr(m.skills);
  if (skills) out.skills = skills;
  const tools = strArr(m.tools);
  if (tools) out.tools = tools;
  const rl = risk(m.risk_level);
  if (rl) out.risk_level = rl;
  if (typeof m.enabled === 'boolean') out.enabled = m.enabled;
  return out;
}

/** Recursively collect file paths under `root` whose basename matches `predicate`. */
function walk(root: string, predicate: (name: string) => boolean): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return found;
  }
  for (const name of names) {
    const full = path.join(root, name);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) found.push(...walk(full, predicate));
    else if (isFile && predicate(name)) found.push(full);
  }
  return found;
}

/**
 * Load every persona under `agentsDir` into a searchable index. A missing
 * directory or unreadable/frontmatter-less files are skipped (never thrown).
 */
export function loadAgentIndex(agentsDir: string, logger?: Logger): AgentIndex {
  const root = path.resolve(agentsDir);
  let exists = false;
  try {
    exists = statSync(root).isDirectory();
  } catch {
    exists = false;
  }

  const records: AgentRecord[] = [];
  const byId = new Map<string, AgentRecord>();
  let collisions = 0;
  let disabled = 0;

  if (exists) {
    const files = walk(root, (n) => n === 'agent.md');
    for (const bodyPath of files) {
      let raw: string;
      try {
        raw = readFileSync(bodyPath, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      const dir = path.dirname(bodyPath);
      const meta = readAgentMetadata(dir);

      const name = fm.name ?? meta?.name;
      if (!name) continue;
      if (meta?.enabled === false) {
        disabled++;
        continue;
      }

      const rel = path.relative(root, bodyPath).split(path.sep);
      const pathCategory = rel.length > 1 && rel[0] ? rel[0] : 'general';
      const category = meta?.category ?? pathCategory;
      const id = meta?.id ?? `${category}/${name}`;
      if (byId.has(id)) {
        collisions++;
        continue;
      }

      const examplesPath = path.join(dir, 'examples.md');
      let hasExamples = false;
      try {
        hasExamples = statSync(examplesPath).isFile();
      } catch {
        hasExamples = false;
      }

      const record: AgentRecord = {
        id,
        name,
        category,
        description: meta?.description ?? fm.description ?? '',
        dir,
        bodyPath,
        ...(hasExamples ? { examplesPath } : {}),
        riskLevel: meta?.risk_level ?? 'low',
        triggerKeywords: (meta?.trigger_keywords ?? []).map((t) => t.toLowerCase()),
        skills: meta?.skills ?? [],
        tools: meta?.tools ?? [],
        ...(meta?.source_repo ? { sourceRepo: meta.source_repo } : {}),
      };
      records.push(record);
      byId.set(id, record);
    }
  }

  const byName = new Map<string, AgentRecord[]>();
  for (const r of records) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }

  logger?.info('agents loaded', {
    dir: root,
    count: records.length,
    duplicatesSkipped: collisions,
    disabledSkipped: disabled,
  });

  return {
    all: records,
    size: records.length,
    get(idOrName: string): AgentRecord | undefined {
      const direct = byId.get(idOrName);
      if (direct) return direct;
      const named = byName.get(idOrName);
      return named && named.length === 1 ? named[0] : undefined;
    },
    byName(name: string): AgentRecord[] {
      return byName.get(name) ?? [];
    },
    search(query: string, limit: number): AgentRecord[] {
      return searchRecords(records, query, limit);
    },
  };
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'at', 'by', 'from',
  'about', 'as', 'is', 'are', 'be', 'do', 'how', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'it', 'that', 'this', 'when', 'use', 'using', 'need', 'want', 'help', 'please', 'can', 'make',
]);

/** Ranked keyword search — coverage dominates, placement breaks ties (mirrors skills). */
function searchRecords(records: readonly AgentRecord[], query: string, limit: number): AgentRecord[] {
  const allTerms = [...new Set(terms(query))];
  if (allTerms.length === 0) return [];
  const content = allTerms.filter((t) => !STOPWORDS.has(t));
  const queryTerms = content.length > 0 ? content : allTerms;

  const scored = records.map((r) => {
    const nameTokens = new Set(terms(r.name));
    const descTokens = new Set(terms(r.description));
    const triggerTokens = new Set(r.triggerKeywords.flatMap(terms));
    let matched = 0;
    let placement = 0;
    for (const t of queryTerms) {
      const inName = nameTokens.has(t);
      const inTrigger = triggerTokens.has(t);
      const inDesc = descTokens.has(t);
      if (inName || inTrigger || inDesc) matched++;
      if (inName || inTrigger) placement += 3;
      else if (inDesc) placement += 1;
    }
    return { r, score: matched * 10 + placement };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id))
    .slice(0, Math.max(1, limit))
    .map((s) => s.r);
}
