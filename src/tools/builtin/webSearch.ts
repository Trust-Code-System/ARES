/**
 * web_search — find pages relevant to a query.
 *
 * Read-only. Built against a pluggable {@link SearchProvider} so the search
 * backend is swappable; a Tavily provider ships here (simple JSON API, generous
 * free tier). The tool is only registered when a provider is configured (see
 * registry wiring), so the model never sees a capability ARES can't fulfil.
 */

import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

const DEFAULT_MAX_RESULTS = 5;

export function createWebSearchTool(provider: SearchProvider): Tool {
  return defineTool({
    name: 'web_search',
    description:
      'Search the web for up-to-date information and return ranked results ' +
      '(title, url, snippet). Follow up with web_fetch to read a result in full.',
    kind: 'read_only',
    schema: z.object({
      query: z.string().describe('The search query.'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe(`How many results to return (1-10, default ${DEFAULT_MAX_RESULTS}).`)
        .optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const max = clampResults(input.max_results);
      const results = await provider.search(input.query, max);
      ctx.logger.info('web search', { provider: provider.name, query: input.query, hits: results.length });
      if (results.length === 0) return { ok: true, content: 'No results found.' };
      const content = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      return { ok: true, content, data: { results } };
    },
  });
}

function clampResults(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

/** Tavily search provider (https://tavily.com). */
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.tavily.com') {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
    return (json.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (r.content ?? '').slice(0, 300),
    }));
  }
}

interface GeminiSearchSdk {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
  };
}

/** Google Search grounding through Gemini, with source URLs returned to ARES. */
export class GeminiGoogleSearchProvider implements SearchProvider {
  readonly name = 'google';
  private readonly sdk: GeminiSearchSdk;

  constructor(
    apiKey: string,
    private readonly model = 'gemini-3.5-flash',
    sdk?: GeminiSearchSdk,
  ) {
    this.sdk = sdk ?? new GoogleGenAI({ apiKey });
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await this.sdk.models.generateContent({
      model: this.model,
      contents:
        `Search Google for the following query. Produce a concise factual research digest ` +
        `that can serve as snippets for the cited source pages.\n\nQuery: ${query}`,
      config: { tools: [{ googleSearch: {} }] },
    });
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const digest = (response.text ?? '').trim().slice(0, 800);
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const chunk of chunks) {
      const web = chunk.web;
      if (!web?.uri || seen.has(web.uri)) continue;
      seen.add(web.uri);
      results.push({
        title: web.title || web.domain || web.uri,
        url: web.uri,
        snippet: digest || `Google Search result for "${query}".`,
      });
      if (results.length >= maxResults) break;
    }
    return results;
  }
}
