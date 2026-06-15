/**
 * GitHub developer tools (Phase 7).
 *
 * Built against a pluggable {@link GithubClient} so the backend is swappable and
 * testable offline. A REST client ships here ({@link RestGithubClient}). The tools
 * are only registered when a client is configured (a GITHUB_TOKEN is present), so
 * the model never sees a capability ARES can't fulfil.
 *
 * Read verbs (`github_search`, `github_read_file`) run ungated. `github_create_issue`
 * is state-mutating and therefore routed through the confirmation gate like every
 * other write — enforced by its `kind`, not the prompt.
 */

import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export type GithubSearchKind = 'repositories' | 'code' | 'issues';

export interface GithubSearchItem {
  title: string;
  url: string;
  detail: string;
}

export interface GithubFile {
  path: string;
  content: string;
  bytes: number;
  url: string;
}

export interface GithubIssue {
  number: number;
  url: string;
}

/** The seam between the GitHub tools and the network. Faked in tests. */
export interface GithubClient {
  readonly name: string;
  search(kind: GithubSearchKind, query: string, maxResults: number): Promise<GithubSearchItem[]>;
  readFile(owner: string, repo: string, path: string, ref?: string): Promise<GithubFile>;
  createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    labels?: string[],
  ): Promise<GithubIssue>;
}

const DEFAULT_MAX_RESULTS = 5;
/** Cap file reads so a large file can't blow the model's context. */
const MAX_FILE_BYTES = 128 * 1024;

export function createGithubTools(client: GithubClient): Tool[] {
  return [
    defineTool({
      name: 'github_search',
      description:
        'Search GitHub for repositories, code, or issues/PRs and return ranked ' +
        'results (title, url, detail). Use to locate a repo, find where something ' +
        'is implemented, or check existing issues. Follow up with github_read_file ' +
        'to read a specific file.',
      kind: 'read_only',
      schema: z.object({
        query: z.string().describe('The GitHub search query (supports GitHub search qualifiers).'),
        kind: z
          .enum(['repositories', 'code', 'issues'])
          .describe('What to search: repositories, code, or issues/PRs. Default repositories.')
          .optional(),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(10)
          .describe(`How many results to return (1-10, default ${DEFAULT_MAX_RESULTS}).`)
          .optional(),
      }),
      async execute(input, ctx): Promise<ToolResult> {
        const kind = input.kind ?? 'repositories';
        const max = clampResults(input.max_results);
        const results = await client.search(kind, input.query, max);
        ctx.logger.info('github search', { kind, query: input.query, hits: results.length });
        if (results.length === 0) return { ok: true, content: 'No results found.' };
        const content = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.detail}`)
          .join('\n\n');
        return { ok: true, content, data: { kind, results } };
      },
    }),

    defineTool({
      name: 'github_read_file',
      description:
        'Read a single file from a GitHub repository and return its text. Use to ' +
        'inspect source you found via github_search. Output is capped for large files.',
      kind: 'read_only',
      schema: z.object({
        owner: z.string().describe('Repository owner (user or org).'),
        repo: z.string().describe('Repository name.'),
        path: z.string().describe('Path to the file within the repo, e.g. "src/index.ts".'),
        ref: z.string().describe('Optional branch, tag, or commit SHA. Defaults to the default branch.').optional(),
      }),
      async execute(input, ctx): Promise<ToolResult> {
        const file = await client.readFile(input.owner, input.repo, input.path, input.ref);
        ctx.logger.info('github read file', {
          repo: `${input.owner}/${input.repo}`,
          path: input.path,
          bytes: file.bytes,
        });
        const capped = file.content.length > MAX_FILE_BYTES;
        const body = capped ? `${file.content.slice(0, MAX_FILE_BYTES)}\n\n…(truncated)` : file.content;
        return {
          ok: true,
          content: body || '(empty file)',
          data: { path: file.path, bytes: file.bytes, url: file.url, truncated: capped },
        };
      },
    }),

    defineTool({
      name: 'github_create_issue',
      description:
        'Open a new issue in a GitHub repository. State-mutating — requires ' +
        'confirmation. Use only when the principal asked to file an issue.',
      kind: 'state_mutating',
      schema: z.object({
        owner: z.string().describe('Repository owner (user or org).'),
        repo: z.string().describe('Repository name.'),
        title: z.string().min(1).describe('Issue title.'),
        body: z.string().describe('Issue body in Markdown.').optional(),
        labels: z.array(z.string()).describe('Optional labels to apply.').optional(),
      }),
      async execute(input, ctx): Promise<ToolResult> {
        const issue = await client.createIssue(
          input.owner,
          input.repo,
          input.title,
          input.body,
          input.labels,
        );
        ctx.logger.info('github issue created', {
          repo: `${input.owner}/${input.repo}`,
          number: issue.number,
        });
        return {
          ok: true,
          content: `Created issue #${issue.number}: ${issue.url}`,
          data: issue,
        };
      },
    }),
  ];
}

function clampResults(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

interface GithubClientOptions {
  token: string;
  baseUrl?: string;
}

/** GitHub REST API client (https://docs.github.com/rest). */
export class RestGithubClient implements GithubClient {
  readonly name = 'github';
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(opts: GithubClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ARES/0.1 (+personal-assistant)',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = parseGithubError(text) ?? res.statusText;
      throw new Error(`GitHub API ${res.status}: ${message}`);
    }
    return res.json() as Promise<T>;
  }

  async search(kind: GithubSearchKind, query: string, maxResults: number): Promise<GithubSearchItem[]> {
    const endpoint = kind === 'repositories' ? 'repositories' : kind === 'code' ? 'code' : 'issues';
    const qs = new URLSearchParams({ q: query, per_page: String(maxResults) });
    const json = await this.request<{ items?: unknown[] }>(`/search/${endpoint}?${qs.toString()}`);
    const items = json.items ?? [];
    return items.slice(0, maxResults).map((raw) => mapSearchItem(kind, raw as Record<string, unknown>));
  }

  async readFile(owner: string, repo: string, path: string, ref?: string): Promise<GithubFile> {
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const json = await this.request<{
      content?: string;
      encoding?: string;
      size?: number;
      path?: string;
      html_url?: string;
      type?: string;
    }>(`/repos/${owner}/${repo}/contents/${encodePath(path)}${qs}`);
    if (json.type && json.type !== 'file') {
      throw new Error(`"${path}" is a ${json.type}, not a file.`);
    }
    const content =
      json.encoding === 'base64' && json.content
        ? Buffer.from(json.content, 'base64').toString('utf8')
        : json.content ?? '';
    return {
      path: json.path ?? path,
      content,
      bytes: json.size ?? content.length,
      url: json.html_url ?? '',
    };
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    labels?: string[],
  ): Promise<GithubIssue> {
    const json = await this.request<{ number: number; html_url: string }>(
      `/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          ...(body ? { body } : {}),
          ...(labels && labels.length ? { labels } : {}),
        }),
      },
    );
    return { number: json.number, url: json.html_url };
  }
}

function mapSearchItem(kind: GithubSearchKind, raw: Record<string, unknown>): GithubSearchItem {
  if (kind === 'repositories') {
    const stars = typeof raw.stargazers_count === 'number' ? `★ ${raw.stargazers_count}` : '';
    return {
      title: String(raw.full_name ?? raw.name ?? 'repository'),
      url: String(raw.html_url ?? ''),
      detail: [String(raw.description ?? '').slice(0, 200), stars].filter(Boolean).join(' · '),
    };
  }
  if (kind === 'code') {
    const repo = (raw.repository as Record<string, unknown> | undefined)?.full_name;
    return {
      title: String(raw.path ?? raw.name ?? 'file'),
      url: String(raw.html_url ?? ''),
      detail: repo ? `in ${String(repo)}` : '',
    };
  }
  const state = raw.state ? String(raw.state) : '';
  const number = typeof raw.number === 'number' ? `#${raw.number}` : '';
  return {
    title: String(raw.title ?? 'issue'),
    url: String(raw.html_url ?? ''),
    detail: [number, state].filter(Boolean).join(' · '),
  };
}

function parseGithubError(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { message?: string };
    return json.message;
  } catch {
    return text ? text.slice(0, 200) : undefined;
  }
}

/** Encode a repo file path for the contents API without escaping the path separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Build a GitHub client from config. Returns undefined when no token is set. */
export function buildGithubClient(config: {
  githubToken?: string;
  githubApiBaseUrl?: string;
}): GithubClient | undefined {
  if (!config.githubToken) return undefined;
  return new RestGithubClient({
    token: config.githubToken,
    ...(config.githubApiBaseUrl ? { baseUrl: config.githubApiBaseUrl } : {}),
  });
}
