/**
 * New capability layer (ChatGPT-parity integration): deep_research,
 * analyze_transcript (Record Mode), generate_image, and effort/depth control.
 * Fully deterministic and offline — search, synthesis, page fetch, and image
 * generation are all fakes; the image tool does a real temp-workspace write.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createDeepResearchTool } from '../src/tools/builtin/deepResearch.js';
import { createRecordingTool } from '../src/tools/builtin/recording.js';
import { createImageGenerationTool } from '../src/tools/builtin/imageGeneration.js';
import { buildImageGenerator, type ImageGenerator } from '../src/llm/imageGen.js';
import { parseEffort, effortProfile } from '../src/agent/effort.js';
import type { SearchProvider, SearchResult } from '../src/tools/builtin/webSearch.js';
import type { Synthesizer } from '../src/llm/synthesize.js';
import type { Logger, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-cap-test' };

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('effort / depth control', () => {
  it('parses levels and degrades unknown values to standard', () => {
    assert.equal(parseEffort('quick'), 'quick');
    assert.equal(parseEffort('DEEP'), 'deep');
    assert.equal(parseEffort('standard'), 'standard');
    assert.equal(parseEffort(undefined), 'standard');
    assert.equal(parseEffort('nonsense'), 'standard');
  });

  it('maps levels to behavioural profiles', () => {
    const quick = effortProfile('quick');
    assert.equal(quick.tierBias, 'fast');
    assert.equal(quick.maxIterationsCap, 3);

    const deep = effortProfile('deep');
    assert.equal(deep.tierBias, 'reasoning');
    assert.equal(deep.forceFullAgent, true);

    const standard = effortProfile('standard');
    assert.equal(standard.tierBias, undefined);
    assert.equal(standard.maxIterationsCap, undefined);
  });
});

describe('deep_research', () => {
  const search: SearchProvider = {
    name: 'fake',
    async search(query, max): Promise<SearchResult[]> {
      return Array.from({ length: max }, (_, i) => ({
        title: `${query} result ${i}`,
        url: `https://example.com/${encodeURIComponent(query)}/${i}`,
        snippet: `snippet for ${query} ${i}`,
      }));
    },
  };

  // Planner returns a JSON array; the report call returns prose. Branch on the system text.
  const synthesize: Synthesizer = async (system) => {
    if (system.includes('plan web research')) return '["sub query a", "sub query b"]';
    return 'Report body with a claim [1] and another [2].';
  };

  const fetchPage = async (url: string) => ({ url, contentType: 'text/html', text: `body of ${url}` });

  it('plans, dedupes sources, reads pages, and returns a cited report', async () => {
    const tool = createDeepResearchTool({ search, synthesize, fetchPage });
    const res = await tool.execute({ question: 'what is X?', depth: 'quick' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /Report body/);
    assert.match(res.content, /## Sources/);
    assert.match(res.content, /\[1\]/);
    const data = res.data as { sources: Array<{ url: string }> };
    // Quick depth caps at 4 sources, all unique URLs.
    assert.equal(data.sources.length, 4);
    assert.equal(new Set(data.sources.map((s) => s.url)).size, 4);
  });

  it('falls back to the raw question when the planner output is unparseable', async () => {
    const badPlanner: Synthesizer = async (system) =>
      system.includes('plan web research') ? 'not json at all' : 'fallback report';
    const tool = createDeepResearchTool({ search, synthesize: badPlanner, fetchPage });
    const res = await tool.execute({ question: 'fallback?' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /fallback report/);
  });

  it('reports cleanly when no sources are found', async () => {
    const empty: SearchProvider = { name: 'empty', async search() { return []; } };
    const tool = createDeepResearchTool({ search: empty, synthesize, fetchPage });
    const res = await tool.execute({ question: 'nothing' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /No sources/);
  });
});

describe('analyze_transcript (Record Mode)', () => {
  it('passes transcript + context to the synthesizer and returns the brief', async () => {
    let seenUser = '';
    const synthesize: Synthesizer = async (_system, user) => {
      seenUser = user;
      return '## Summary\nWe shipped.\n## Action items\n- Ada: write tests (no date)';
    };
    const tool = createRecordingTool(synthesize);
    const res = await tool.execute(
      { transcript: 'Ada will write tests. We shipped the build.', context: 'standup' },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.match(res.content, /Action items/);
    assert.match(seenUser, /Context: standup/);
    assert.match(seenUser, /Ada will write tests/);
  });
});

describe('generate_image', () => {
  const generator: ImageGenerator = {
    provider: 'fake',
    model: 'fake-image-1',
    async generate() {
      return { base64: TINY_PNG_B64, mediaType: 'image/png' };
    },
  };

  it('renders an image into the workspace and reports the path', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'ares-img-'));
    const tool = createImageGenerationTool(generator, ws);
    const res = await tool.execute({ prompt: 'a cat', filename: 'cat.png' }, ctx);
    assert.equal(res.ok, true);
    const data = res.data as { file: string };
    const bytes = await readFile(path.join(ws, data.file));
    assert.ok(bytes.length > 0);
  });

  it('forces the extension to match the returned media type', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'ares-img-'));
    const tool = createImageGenerationTool(generator, ws);
    const res = await tool.execute({ prompt: 'x', filename: 'art.jpg' }, ctx);
    const data = res.data as { file: string };
    assert.match(data.file, /\.png$/);
  });

  it('is state_mutating (so it passes through the gate)', () => {
    const tool = createImageGenerationTool(generator, '/tmp');
    assert.equal(tool.kind, 'state_mutating');
  });

  it('rejects a filename that escapes the workspace jail', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'ares-img-'));
    const tool = createImageGenerationTool(generator, ws);
    await assert.rejects(
      () => tool.execute({ prompt: 'x', filename: '../escape.png' }, ctx),
      /escapes the workspace sandbox/,
    );
  });
});

describe('buildImageGenerator', () => {
  it('returns undefined with no provider key', () => {
    assert.equal(buildImageGenerator({} as NodeJS.ProcessEnv), undefined);
  });

  it('selects OpenAI when only an OpenAI key is present', () => {
    const gen = buildImageGenerator({ OPENAI_API_KEY: 'sk-x' } as unknown as NodeJS.ProcessEnv);
    assert.equal(gen?.provider, 'openai');
  });

  it('honours an explicit gemini choice', () => {
    const gen = buildImageGenerator({
      OPENAI_API_KEY: 'sk-x',
      GEMINI_API_KEY: 'g-x',
      ARES_IMAGE_PROVIDER: 'gemini',
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(gen?.provider, 'gemini');
  });
});
