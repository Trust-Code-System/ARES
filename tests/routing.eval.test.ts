/**
 * Routing eval harness (Phase 11) — deterministic, offline.
 *
 * Asserts the two routing decisions the Jarvis system depends on, using the
 * project's PROMPT examples as cases:
 *  - Skill routing: a user request reaches the expected skill via find_skill
 *    over the REAL vendored library.
 *  - Model routing: a task shape reaches the expected provider via selectRoute.
 *
 * These are the regression backbone described in the context-engineering
 * `evaluation-loops` skill: cheap, deterministic, no network or model calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

import { loadSkillIndex } from '../src/skills/loader.js';
import { selectRoute, type Provider } from '../src/llm/router.js';

const SKILLS_DIR = path.resolve(process.cwd(), 'skills');
const ALL = new Set<Provider>(['anthropic', 'openai', 'gemini']);
const ORDER: Provider[] = ['anthropic', 'openai', 'gemini'];

describe('eval: skill routing over the real library', () => {
  const idx = loadSkillIndex(SKILLS_DIR);

  // [user request, an id substring that MUST appear in the top-k matches]
  const cases: Array<[string, string]> = [
    ['Make my dashboard look premium', 'ui-ux/'],
    ['Rewrite this so it does not sound AI-generated', 'writing/stop-slop'],
    ['Create a 30-second promo video', 'video/remotion'],
    ['Design the agent memory architecture', 'context-engineering/memory-design'],
    ['How should I manage the context window in a long run', 'context-engineering/context-window-management'],
    ['Make this landing page accessible and responsive', 'ui-ux/accessibility-responsive'],
  ];

  for (const [request, expected] of cases) {
    it(`"${request}" → ${expected}`, () => {
      const hits = idx.search(request, 5).map((h) => h.id);
      assert.ok(
        hits.some((id) => id.includes(expected)),
        `expected a match containing "${expected}" in top-5, got: ${hits.join(', ')}`,
      );
    });
  }
});

describe('eval: model routing by task shape', () => {
  const cases: Array<[string, Parameters<typeof selectRoute>[0], Provider]> = [
    ['deep coding task', { kind: 'code' }, 'anthropic'],
    ['architecture / large codebase', { kind: 'architecture', needsLongContext: true }, 'anthropic'],
    ['strict JSON / structured output', { needsStructuredOutput: true }, 'openai'],
    ['voice / latency-sensitive chat', { latencySensitive: true }, 'openai'],
  ];

  for (const [label, task, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      assert.equal(selectRoute(task, ALL, ORDER).provider, expected);
    });
  }

  it('latency-sensitive work uses the fast tier', () => {
    assert.equal(selectRoute({ latencySensitive: true }, ALL, ORDER).tier, 'fast');
  });
});
