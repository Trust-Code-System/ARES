/**
 * Skill library loader.
 *
 * A "skill" is a vendored `SKILL.md` file (markdown playbook + YAML frontmatter
 * with `name` and `description`) under `skills/`, optionally accompanied by
 * Python scripts and reference material in the same directory. This module
 * discovers them, parses just the two frontmatter fields the index needs, and
 * builds an in-memory catalog the `find_skill`/`use_skill` tools search and read.
 *
 * The library carries the same skill under more than one layout/category, so a
 * skill is keyed by a stable `id` of `<category>/<name>` (category = the first
 * path segment under the skills root). Identical ids are de-duplicated
 * first-wins; a bare `name` that maps to several ids is disambiguated at lookup.
 *
 * Loading is filesystem-only — no skill code is executed here. Bundled scripts
 * run exclusively through the gated, audited `run_python` tool.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import { installedRepoRootFor } from './installPaths.js';

/** Max bytes of a SKILL.md body returned to the model (keeps context bounded). */
export const MAX_SKILL_BODY_BYTES = 64 * 1024;

export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * Optional `metadata.json` sidecar a skill may carry next to its SKILL.md. Every
 * field is optional; the loader falls back to frontmatter / path-derived values.
 * This is the richer routing surface (provenance, triggers, risk) layered over
 * the minimal frontmatter the original index needed.
 */
export interface SkillMetadata {
  id?: string;
  name?: string;
  category?: string;
  /** Upstream repo the skill was vendored from (provenance / audit). */
  source_repo?: string;
  /** Extra keywords that should route to this skill (boost search). */
  trigger_keywords?: string[];
  /** Tools the skill's process expects to be available. */
  required_tools?: string[];
  /** Coarse risk grade surfaced to the model when listing the skill. */
  risk_level?: RiskLevel;
  /** When false, the skill is excluded from the index entirely. */
  enabled?: boolean;
  version?: string;
}

export interface SkillRecord {
  /** Stable unique key: `<category>/<name>`. */
  id: string;
  /** Frontmatter `name`. */
  name: string;
  /** First path segment under the skills root (the domain bucket). */
  category: string;
  /** Frontmatter `description` (the routing/trigger text). */
  description: string;
  /** Absolute path to the skill's directory (the SKILL.md's parent). */
  dir: string;
  /** Absolute path to the SKILL.md file. */
  bodyPath: string;
  /** Absolute paths of `*.py` scripts bundled under the skill directory. */
  scripts: string[];
  /** Risk grade from metadata.json (default `low` when no sidecar/field). */
  riskLevel: RiskLevel;
  /** Extra routing keywords from metadata.json (lowercased), if any. */
  triggerKeywords: string[];
  /** Upstream provenance from metadata.json, if declared. */
  sourceRepo?: string;
  /** Version string from metadata.json, if declared. */
  version?: string;
}

export interface SkillIndex {
  /** Every loaded skill, in discovery order. */
  readonly all: readonly SkillRecord[];
  /** Total skills loaded. */
  readonly size: number;
  /** Exact lookup by `id` (`<category>/<name>`) or, if unambiguous, by bare `name`. */
  get(idOrName: string): SkillRecord | undefined;
  /** All skills whose bare `name` equals `name`. */
  byName(name: string): SkillRecord[];
  /** Ranked keyword search over name + description; best first. */
  search(query: string, limit: number): SkillRecord[];
}

/** Parsed subset of a SKILL.md's YAML frontmatter. */
interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Extract `name` and `description` from a leading `---`-fenced YAML block.
 *
 * Deliberately minimal (no YAML dependency): it handles plain scalars, single/
 * double-quoted scalars, and `|`/`>` block scalars for the two top-level keys we
 * use. Anything else in the frontmatter is ignored.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, '');
  if (!normalized.startsWith('---')) return {};
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};

  const out: Frontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break; // end of frontmatter

    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!m) continue; // skip nested/list/continuation lines
    const key = m[1];
    if (key !== 'name' && key !== 'description') continue;
    let rawValue = (m[2] ?? '').trim();

    if (rawValue === '|' || rawValue === '>' || rawValue === '|-' || rawValue === '>-') {
      // Block scalar: gather subsequent more-indented lines.
      const block: string[] = [];
      const baseIndent = leadingSpaces(lines[i + 1] ?? '');
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        if (next.trim() === '') {
          block.push('');
          i++;
          continue;
        }
        if (leadingSpaces(next) < baseIndent) break;
        block.push(next.slice(baseIndent));
        i++;
      }
      const folded = rawValue.startsWith('>') ? block.join(' ') : block.join('\n');
      out[key] = folded.trim();
      continue;
    }

    out[key] = unquote(rawValue);
  }
  return out;
}

function leadingSpaces(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m?.[1] ? m[1].length : 0;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

/**
 * Read and validate an optional `metadata.json` sitting next to a SKILL.md.
 * Missing/unreadable/malformed files yield `undefined` (never throw) so a bad
 * sidecar degrades to frontmatter behaviour rather than dropping the skill.
 */
export function readMetadata(dir: string): SkillMetadata | undefined {
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

  const out: SkillMetadata = {};
  const id = str(m.id);
  if (id) out.id = id;
  const name = str(m.name);
  if (name) out.name = name;
  const category = str(m.category);
  if (category) out.category = category;
  const sourceRepo = str(m.source_repo);
  if (sourceRepo) out.source_repo = sourceRepo;
  const triggers = strArr(m.trigger_keywords);
  if (triggers) out.trigger_keywords = triggers;
  const tools = strArr(m.required_tools);
  if (tools) out.required_tools = tools;
  const rl = risk(m.risk_level);
  if (rl) out.risk_level = rl;
  if (typeof m.enabled === 'boolean') out.enabled = m.enabled;
  const version = str(m.version);
  if (version) out.version = version;
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
    if (isDir) {
      found.push(...walk(full, predicate));
    } else if (isFile && predicate(name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Load every skill under `skillsDir` into a searchable index. Missing directory
 * or unreadable/frontmatter-less files are skipped (never thrown), so a bad
 * skill can't take the assistant down.
 */
export function loadSkillIndex(skillsDir: string, logger?: Logger): SkillIndex {
  const root = path.resolve(skillsDir);
  let exists = false;
  try {
    exists = statSync(root).isDirectory();
  } catch {
    exists = false;
  }

  const records: SkillRecord[] = [];
  const byId = new Map<string, SkillRecord>();
  let collisions = 0;
  let disabled = 0;

  if (exists) {
    const skillFiles = walk(root, (n) => n === 'SKILL.md');
    for (const bodyPath of skillFiles) {
      let raw: string;
      try {
        raw = readFileSync(bodyPath, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      const dir = path.dirname(bodyPath);
      const meta = readMetadata(dir);

      // metadata.json may carry name/description, but a skill with neither a
      // frontmatter name nor a metadata name is treated as a sample asset.
      const name = fm.name ?? meta?.name;
      if (!name) continue;

      // An explicitly disabled skill is excluded from the index entirely.
      if (meta?.enabled === false) {
        disabled++;
        continue;
      }

      const installedRepo = installedRepoRootFor(root, bodyPath);
      const recordRoot = installedRepo?.root ?? root;
      const rel = path.relative(recordRoot, bodyPath).split(path.sep);
      const pathCategory =
        rel.length > 1 && rel[0]
          ? rel[0]
          : installedRepo
            ? `${installedRepo.owner}-${installedRepo.repo}`
            : 'general';
      const category = meta?.category ?? pathCategory;
      const id = meta?.id ?? `${category}/${name}`;
      if (byId.has(id)) {
        collisions++;
        continue; // identical duplicate layout — first wins
      }

      const scripts = walk(dir, (n) => n.endsWith('.py')).sort();
      const record: SkillRecord = {
        id,
        name,
        category,
        description: fm.description ?? '',
        dir,
        bodyPath,
        scripts,
        riskLevel: meta?.risk_level ?? 'low',
        triggerKeywords: (meta?.trigger_keywords ?? []).map((t) => t.toLowerCase()),
        ...(meta?.source_repo || installedRepo
          ? { sourceRepo: meta?.source_repo ?? `https://github.com/${installedRepo?.owner}/${installedRepo?.repo}` }
          : {}),
        ...(meta?.version ? { version: meta.version } : {}),
      };
      records.push(record);
      byId.set(id, record);
    }
  }

  const byName = new Map<string, SkillRecord[]>();
  for (const r of records) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }

  logger?.info('skills loaded', {
    dir: root,
    count: records.length,
    duplicatesSkipped: collisions,
    disabledSkipped: disabled,
  });

  return {
    all: records,
    size: records.length,
    get(idOrName: string): SkillRecord | undefined {
      const direct = byId.get(idOrName);
      if (direct) return direct;
      const named = byName.get(idOrName);
      return named && named.length === 1 ? named[0] : undefined;
    },
    byName(name: string): SkillRecord[] {
      return byName.get(name) ?? [];
    },
    search(query: string, limit: number): SkillRecord[] {
      return searchRecords(records, query, limit);
    },
  };
}

/** Tokenize into lowercased alphanumeric terms. */
function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Common words that carry no routing signal — dropped from a query before scoring. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'at', 'by', 'from',
  'about', 'as', 'is', 'are', 'be', 'do', 'how', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'it', 'that', 'this', 'when', 'use', 'using', 'need', 'want', 'help', 'please', 'can',
]);

function searchRecords(records: readonly SkillRecord[], query: string, limit: number): SkillRecord[] {
  const allTerms = [...new Set(terms(query))];
  if (allTerms.length === 0) return [];
  // Prefer content words; fall back to everything if the query was all stopwords.
  const content = allTerms.filter((t) => !STOPWORDS.has(t));
  const queryTerms = content.length > 0 ? content : allTerms;
  const phrase = query.trim().toLowerCase();

  const scored = records.map((r) => {
    // Match whole words, not substrings: a short term like "ai" must not score
    // against "email"/"testrail", nor "writing" against "copywriting".
    const nameTokens = new Set(terms(r.name));
    const idTokens = new Set(terms(r.id));
    const descTokens = new Set(terms(r.description));
    // Explicit trigger keywords are an author's routing hints — weighted like a
    // name match so a metadata-tagged skill surfaces for its declared triggers.
    const triggerTokens = new Set(r.triggerKeywords.flatMap(terms));
    // Coverage (how many distinct query terms the skill matches at all) dominates;
    // where the match lands only breaks ties. One strong term in a name shouldn't
    // beat a skill that matches most of the query in its description.
    let matched = 0;
    let placement = 0;
    for (const t of queryTerms) {
      const inName = nameTokens.has(t);
      const inTrigger = triggerTokens.has(t);
      const inId = idTokens.has(t);
      const inDesc = descTokens.has(t);
      if (inName || inTrigger || inId || inDesc) matched++;
      if (inName || inTrigger) placement += 3;
      else if (inId) placement += 2;
      else if (inDesc) placement += 1;
    }
    let score = matched * 10 + placement;
    // Whole-phrase boosts reward tighter matches over scattered term hits.
    if (phrase && r.name.toLowerCase().includes(phrase)) score += 8;
    if (phrase && r.description.toLowerCase().includes(phrase)) score += 3;
    return { r, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id))
    .slice(0, Math.max(1, limit))
    .map((s) => s.r);
}
