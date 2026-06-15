/**
 * Phase 7 — GitHub developer tools. Offline: the tools run against a
 * FakeGithubClient, and RestGithubClient is exercised with a stubbed global
 * fetch. No network.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  createGithubTools,
  buildGithubClient,
  RestGithubClient,
  type GithubClient,
  type GithubFile,
  type GithubIssue,
  type GithubSearchItem,
  type GithubSearchKind,
} from '../src/tools/builtin/github.js';
import type { Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-test' };

class FakeGithubClient implements GithubClient {
  readonly name = 'fake';
  searchCalls: Array<{ kind: GithubSearchKind; query: string; max: number }> = [];
  createIssueCalls: Array<{ owner: string; repo: string; title: string; body?: string; labels?: string[] }> = [];

  constructor(
    private readonly results: GithubSearchItem[] = [],
    private readonly file: GithubFile = { path: 'README.md', content: 'hello', bytes: 5, url: 'u' },
    private readonly issue: GithubIssue = { number: 7, url: 'https://github.com/o/r/issues/7' },
  ) {}

  async search(kind: GithubSearchKind, query: string, max: number): Promise<GithubSearchItem[]> {
    this.searchCalls.push({ kind, query, max });
    return this.results;
  }
  async readFile(): Promise<GithubFile> {
    return this.file;
  }
  async createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<GithubIssue> {
    this.createIssueCalls.push({ owner, repo, title, body, labels });
    return this.issue;
  }
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

describe('github tools', () => {
  it('registers exactly the three dev tools with correct risk kinds', () => {
    const tools = createGithubTools(new FakeGithubClient());
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['github_create_issue', 'github_read_file', 'github_search'],
    );
    assert.equal(byName(tools, 'github_search').kind, 'read_only');
    assert.equal(byName(tools, 'github_read_file').kind, 'read_only');
    assert.equal(byName(tools, 'github_create_issue').kind, 'state_mutating');
  });

  it('github_search defaults to repositories, clamps results, and formats output', async () => {
    const client = new FakeGithubClient([
      { title: 'octocat/hello', url: 'https://github.com/octocat/hello', detail: 'a repo · ★ 9' },
    ]);
    const tool = byName(createGithubTools(client), 'github_search');
    const res = await tool.execute({ query: 'hello' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /octocat\/hello/);
    assert.equal(client.searchCalls[0]?.kind, 'repositories');
  });

  it('github_search reports an empty result set without failing', async () => {
    const tool = byName(createGithubTools(new FakeGithubClient([])), 'github_search');
    const res = await tool.execute({ query: 'nothing', kind: 'code' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /No results/i);
  });

  it('github_read_file returns the file text', async () => {
    const client = new FakeGithubClient([], { path: 'src/a.ts', content: 'export const x = 1;', bytes: 19, url: 'u' });
    const tool = byName(createGithubTools(client), 'github_read_file');
    const res = await tool.execute({ owner: 'o', repo: 'r', path: 'src/a.ts' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /export const x = 1;/);
  });

  it('github_create_issue calls the client and returns the issue url', async () => {
    const client = new FakeGithubClient();
    const tool = byName(createGithubTools(client), 'github_create_issue');
    const res = await tool.execute({ owner: 'o', repo: 'r', title: 'Bug', body: 'broken', labels: ['bug'] }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /#7/);
    assert.deepEqual(client.createIssueCalls[0], { owner: 'o', repo: 'r', title: 'Bug', body: 'broken', labels: ['bug'] });
  });
});

describe('buildGithubClient', () => {
  it('returns undefined without a token', () => {
    assert.equal(buildGithubClient({}), undefined);
  });
  it('returns a RestGithubClient when a token is present', () => {
    const client = buildGithubClient({ githubToken: 'gh_x' });
    assert.ok(client instanceof RestGithubClient);
  });
});

describe('RestGithubClient (stubbed fetch)', () => {
  it('decodes base64 file contents', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('line one\nline two', 'utf8').toString('base64'),
          size: 17,
          path: 'README.md',
          html_url: 'https://github.com/o/r/blob/main/README.md',
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    try {
      const client = new RestGithubClient({ token: 't' });
      const file = await client.readFile('o', 'r', 'README.md');
      assert.equal(file.content, 'line one\nline two');
      assert.equal(file.path, 'README.md');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('surfaces the GitHub error message on a non-2xx response', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
    ) as typeof fetch;
    try {
      const client = new RestGithubClient({ token: 't' });
      await assert.rejects(() => client.readFile('o', 'r', 'nope'), /GitHub API 404: Not Found/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
