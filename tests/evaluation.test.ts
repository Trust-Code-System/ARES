/**
 * Phase 6 — the behavioural eval harness. Deterministic and offline: the pure
 * runner, the ARES evaluator over a real ToolRegistry + the secret detector + a
 * fake skill index, case validation, and the shipped suite against the real
 * vendored skill library.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

import {
  buildAresEvaluator,
  parseCases,
  runEval,
  type EvalCase,
} from '../src/evaluation/index.js';
import { loadCasesFromFile } from '../src/evaluation/cases.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTaskTools } from '../src/tools/builtin/tasks.js';
import { createFeedbackTools } from '../src/tools/builtin/feedback.js';
import { createFileTools } from '../src/tools/builtin/files.js';
import { createMemoryTools } from '../src/tools/builtin/memory.js';
import { createWebSearchTool, type SearchProvider } from '../src/tools/builtin/webSearch.js';
import { createBrowserTools, type BrowserController, type NavResult, type PageSnapshot } from '../src/tools/builtin/browser.js';
import { createEmailTools } from '../src/tools/builtin/email.js';
import { InMemoryTaskStore } from '../src/tasks/store.js';
import { InMemoryFeedbackStore } from '../src/feedback/store.js';
import { InMemoryStructuredStore } from '../src/memory/stores.js';
import { loadSkillIndex } from '../src/skills/loader.js';

const stubSearch: SearchProvider = { name: 'stub', async search() { return []; } };
const emptySnap: PageSnapshot = { url: '', title: '', text: '', fields: [], buttons: [] };
const stubBrowser: BrowserController = {
  async navigate(): Promise<NavResult> { return { url: '', title: '' }; },
  async snapshot(): Promise<PageSnapshot> { return emptySnap; },
  async fill() {}, async click() {},
  async submit(): Promise<NavResult> { return { url: '', title: '' }; },
  async close() {},
};

function realRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of createFileTools(process.cwd())) reg.register(t);
  for (const t of createTaskTools(new InMemoryTaskStore())) reg.register(t);
  for (const t of createFeedbackTools(new InMemoryFeedbackStore())) reg.register(t);
  for (const t of createMemoryTools(new InMemoryStructuredStore())) reg.register(t);
  for (const t of createBrowserTools(stubBrowser)) reg.register(t);
  for (const t of createEmailTools({ sender: async () => ({ id: 'stub' }) })) reg.register(t);
  reg.register(createWebSearchTool(stubSearch));
  return reg;
}

describe('runEval', () => {
  it('tallies pass/fail/skip per category and tolerates a throwing evaluator', async () => {
    const cases: EvalCase[] = [
      { name: 'a', category: 'file_handling', probe: { type: 'tool_presence', tool: 'read_file', registered: true } },
      { name: 'b', category: 'file_handling', probe: { type: 'tool_presence', tool: 'nope', registered: true } },
      { name: 'c', category: 'web_research', probe: { type: 'llm_judge', input: 'x', expect: 'y' } },
    ];
    const report = await runEval(cases, buildAresEvaluator({ registry: realRegistry() }));
    assert.equal(report.total, 3);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.byCategory.file_handling!.passed, 1);
    assert.equal(report.byCategory.file_handling!.failed, 1);
  });

  it('counts an evaluator exception as a fail, not a crash', async () => {
    const cases: EvalCase[] = [
      { name: 'boom', category: 'coding_help', probe: { type: 'llm_judge', input: 'x', expect: 'y' } },
    ];
    const report = await runEval(cases, () => { throw new Error('kaboom'); });
    assert.equal(report.failed, 1);
    assert.match(report.results[0]!.detail, /kaboom/);
  });
});

describe('buildAresEvaluator probes', () => {
  const evaluate = buildAresEvaluator({ registry: realRegistry() });

  it('passes when a state_mutating tool requires confirmation', async () => {
    const r = await evaluate({ name: 't', category: 'confirmation_behavior', probe: { type: 'tool_gating', tool: 'write_file', requiresConfirmation: true } });
    assert.equal(r.status, 'pass');
  });

  it('fails when a read_only tool is wrongly expected to be gated', async () => {
    const r = await evaluate({ name: 't', category: 'file_handling', probe: { type: 'tool_gating', tool: 'read_file', requiresConfirmation: true } });
    assert.equal(r.status, 'fail');
  });

  it('fails when the gated tool is not even registered', async () => {
    const r = await evaluate({ name: 't', category: 'email_safety', probe: { type: 'tool_gating', tool: 'wire_money', requiresConfirmation: true } });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /not registered/);
  });

  it('blocks input containing a secret (privacy)', async () => {
    const r = await evaluate({ name: 't', category: 'privacy_protection', probe: { type: 'privacy', input: { note: 'password is hunter2!' }, blocked: true } });
    assert.equal(r.status, 'pass');
  });

  it('does not block benign input (privacy)', async () => {
    const r = await evaluate({ name: 't', category: 'privacy_protection', probe: { type: 'privacy', input: { title: 'buy milk' }, blocked: false } });
    assert.equal(r.status, 'pass');
  });

  it('skips skill_routing when no index is provided', async () => {
    const r = await evaluate({ name: 't', category: 'tool_selection', probe: { type: 'skill_routing', request: 'x', expectMatch: 'y' } });
    assert.equal(r.status, 'skip');
  });

  it('skips llm_judge probes', async () => {
    const r = await evaluate({ name: 't', category: 'web_research', probe: { type: 'llm_judge', input: 'x', expect: 'y' } });
    assert.equal(r.status, 'skip');
  });
});

describe('case validation', () => {
  it('rejects an unknown category', () => {
    assert.throws(() =>
      parseCases({ cases: [{ name: 'x', category: 'made_up', probe: { type: 'tool_presence', tool: 't', registered: true } }] }),
    );
  });

  it('rejects an unknown probe type', () => {
    assert.throws(() =>
      parseCases({ cases: [{ name: 'x', category: 'file_handling', probe: { type: 'nope' } }] }),
    );
  });
});

describe('shipped suite over the real components', () => {
  it('ares-behavior.v1 has zero FAILs (skips allowed)', async () => {
    const cases = loadCasesFromFile(path.resolve(process.cwd(), 'ai-training/evaluations/ares-behavior.v1.json'));
    const skillIndex = loadSkillIndex(path.resolve(process.cwd(), 'skills'));
    const report = await runEval(cases, buildAresEvaluator({ registry: realRegistry(), skillIndex }));
    assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => r.status === 'fail'), null, 2));
    assert.ok(report.passed > 0);
  });
});
