/**
 * deep_research — autonomous, cited research synthesis.
 *
 * This is ARES's answer to "Deep Research": not a single search wrapper but a
 * small fan-out pipeline. Given a question it (1) plans a handful of focused
 * sub-queries, (2) searches each, (3) reads the top unique source pages under
 * the same SSRF-guarded fetcher web_fetch uses, and (4) asks the model to write
 * one synthesized report with inline numbered citations back to those sources.
 *
 * Read-only: it only searches and reads, never mutates. It needs a search
 * backend and a synthesizer, so it's registered only when a search provider is
 * configured (same conditional as web_search) — the model never sees a
 * capability ARES can't fulfil. The model can save the returned report with
 * write_file when a durable artifact is wanted.
 */

import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import type { SearchProvider, SearchResult } from './webSearch.js';
import { fetchReadablePage } from '../net/fetchPage.js';
import type { Synthesizer } from '../../llm/synthesize.js';

/** How wide/deep the fan-out goes. */
const DEPTH_PLAN = {
  quick: { subQueries: 2, resultsPerQuery: 4, sources: 4, perSourceChars: 2000 },
  standard: { subQueries: 4, resultsPerQuery: 5, sources: 8, perSourceChars: 2500 },
  deep: { subQueries: 6, resultsPerQuery: 6, sources: 12, perSourceChars: 3000 },
} as const;

type Depth = keyof typeof DEPTH_PLAN;

export interface DeepResearchDeps {
  search: SearchProvider;
  synthesize: Synthesizer;
  /** Injectable for tests; defaults to the shared SSRF-guarded fetcher. */
  fetchPage?: typeof fetchReadablePage;
}

export function createDeepResearchTool(deps: DeepResearchDeps): ReturnType<typeof defineTool> {
  const fetchPage = deps.fetchPage ?? fetchReadablePage;

  return defineTool({
    name: 'deep_research',
    description:
      'Run a deep, multi-source research pass on a question: plan sub-queries, ' +
      'search the web, read the best sources, and return a synthesized report with ' +
      'inline numbered citations and a sources list. Use for questions that need ' +
      'several angles compared and evidence weighed — not a single quick lookup ' +
      '(use web_search for that). Save the report with write_file if a durable ' +
      'artifact is wanted.',
    kind: 'read_only',
    schema: z.object({
      question: z.string().min(1).describe('The research question or topic.'),
      depth: z
        .enum(['quick', 'standard', 'deep'])
        .describe('How wide to search (default standard).')
        .optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const plan = DEPTH_PLAN[(input.depth ?? 'standard') as Depth];
      const signal = ctx.signal;

      // 1. Plan focused sub-queries (one cheap fast-tier call). Fail-safe: if the
      //    planner output can't be parsed, fall back to the raw question.
      const subQueries = await planSubQueries(deps.synthesize, input.question, plan.subQueries, signal);
      ctx.logger.info('deep_research planned', { question: input.question, subQueries });

      // 2. Search each sub-query, collecting unique sources (dedup by URL).
      const sources = await gatherSources(deps.search, subQueries, plan, signal);
      if (sources.length === 0) {
        return { ok: true, content: 'No sources were found for this question.' };
      }

      // 3. Read each source page; tolerate individual fetch failures.
      const read = await readSources(fetchPage, sources, plan.perSourceChars, signal);
      const usable = read.filter((s) => s.text.length > 0);
      if (usable.length === 0) {
        return {
          ok: true,
          content:
            'Found sources but none could be read (all fetches failed). Sources:\n' +
            sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n'),
          data: { sources },
        };
      }

      // 4. Synthesize one cited report from the read material.
      const report = await synthesizeReport(deps.synthesize, input.question, read, signal);
      ctx.logger.info('deep_research synthesized', {
        sources: sources.length,
        read: usable.length,
        subQueries: subQueries.length,
      });

      const sourceList = read
        .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}${s.text ? '' : ' (unreadable)'}`)
        .join('\n');

      return {
        ok: true,
        content: `${report}\n\n## Sources\n${sourceList}`,
        data: { question: input.question, subQueries, sources: read.map((s) => ({ title: s.title, url: s.url })) },
      };
    },
  });
}

const PLANNER_SYSTEM =
  'You plan web research. Given a question, output ONLY a JSON array of short, ' +
  'distinct web search queries (no prose, no markdown) that together cover the ' +
  'question from complementary angles. Each query is a plain string.';

async function planSubQueries(
  synthesize: Synthesizer,
  question: string,
  count: number,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  try {
    const raw = await synthesize(
      PLANNER_SYSTEM,
      `Question: ${question}\n\nReturn ${count} search queries as a JSON array of strings.`,
      { tier: 'fast', maxTokens: 400, ...(signal ? { signal } : {}) },
    );
    const queries = parseJsonStringArray(raw);
    const cleaned = queries.map((q) => q.trim()).filter(Boolean).slice(0, count);
    return cleaned.length > 0 ? cleaned : [question];
  } catch {
    return [question];
  }
}

interface ReadSource extends SearchResult {
  /** Extracted page text (empty when the fetch failed). */
  text: string;
}

async function gatherSources(
  search: SearchProvider,
  subQueries: string[],
  plan: (typeof DEPTH_PLAN)[Depth],
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const seen = new Set<string>();
  const sources: SearchResult[] = [];
  for (const query of subQueries) {
    if (signal?.aborted) break;
    let results: SearchResult[] = [];
    try {
      results = await search.search(query, plan.resultsPerQuery);
    } catch {
      continue; // a single failed sub-query shouldn't sink the whole run
    }
    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      sources.push(r);
      if (sources.length >= plan.sources) return sources;
    }
  }
  return sources;
}

async function readSources(
  fetchPage: typeof fetchReadablePage,
  sources: SearchResult[],
  perSourceChars: number,
  signal: AbortSignal | undefined,
): Promise<ReadSource[]> {
  const pages = await Promise.all(
    sources.map(async (s): Promise<ReadSource> => {
      try {
        const page = await fetchPage(s.url, signal ? { signal } : {});
        return { ...s, text: page.text.slice(0, perSourceChars) };
      } catch {
        // Fall back to the search snippet so the source still contributes.
        return { ...s, text: (s.snippet ?? '').slice(0, perSourceChars) };
      }
    }),
  );
  return pages;
}

const REPORT_SYSTEM =
  'You are a rigorous research analyst. Write a clear, well-structured report that ' +
  'answers the question using ONLY the provided sources. Cite claims inline with ' +
  'bracketed numbers matching the source list (e.g. [1], [2]). Compare sources, note ' +
  'disagreements, and state plainly when the evidence is thin or sources conflict. ' +
  'Do not invent facts or citations. Use markdown headings and concise prose.';

async function synthesizeReport(
  synthesize: Synthesizer,
  question: string,
  sources: ReadSource[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const corpus = sources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.text || '(no readable text — snippet only)'}`)
    .join('\n\n---\n\n');
  return synthesize(
    REPORT_SYSTEM,
    `Question: ${question}\n\nSources:\n\n${corpus}\n\n` +
      'Write the cited report now. Do not repeat the raw sources list; it is appended separately.',
    { tier: 'reasoning', maxTokens: 4000, ...(signal ? { signal } : {}) },
  );
}

/** Parse a JSON array of strings, tolerating code fences and stray prose. */
function parseJsonStringArray(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}
