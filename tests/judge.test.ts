/**
 * Phase 6 — the LLM-judge evaluator. Offline: fake respond/grade functions, so
 * no model is called. Also covers parseVerdict's tolerance of chatty model output
 * and the evaluator's integration via buildAresEvaluator's `judge` seam.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildModelJudge, parseVerdict } from '../src/evaluation/judge.js';
import { buildAresEvaluator } from '../src/evaluation/aresEvaluator.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { EvalCase } from '../src/evaluation/types.js';

const judgeCase: EvalCase = {
  name: 'cites sources',
  category: 'citation_accuracy',
  probe: { type: 'llm_judge', input: 'What were the jobs numbers?', expect: 'Cites a dated source.' },
};

describe('parseVerdict', () => {
  it('parses a clean JSON verdict', () => {
    assert.deepEqual(parseVerdict('{"pass": true, "reason": "cited BLS"}'), { pass: true, reason: 'cited BLS' });
  });
  it('extracts JSON embedded in prose', () => {
    const v = parseVerdict('Sure! Here is my verdict: {"pass": false, "reason": "no source"} — hope that helps');
    assert.equal(v.pass, false);
    assert.equal(v.reason, 'no source');
  });
  it('fails closed on unparseable output', () => {
    assert.equal(parseVerdict('the answer is yes').pass, false);
  });
  it('treats a non-true pass value as false', () => {
    assert.equal(parseVerdict('{"pass": "yes"}').pass, false);
  });
});

describe('buildModelJudge', () => {
  it('passes when grade passes, and forwards the response', async () => {
    let seenResponse = '';
    const judge = buildModelJudge({
      async respond(input) { return `answer to: ${input}`; },
      async grade({ response }) { seenResponse = response; return { pass: true, reason: 'good' }; },
    });
    const out = await judge(judgeCase);
    assert.equal(out.status, 'pass');
    assert.equal(out.detail, 'good');
    assert.equal(seenResponse, 'answer to: What were the jobs numbers?');
  });

  it('fails when grade fails', async () => {
    const judge = buildModelJudge({
      async respond() { return 'x'; },
      async grade() { return { pass: false, reason: 'no citation' }; },
    });
    assert.equal((await judge(judgeCase)).status, 'fail');
  });

  it('counts a respond/grade exception as a fail, not a throw', async () => {
    const judge = buildModelJudge({
      async respond() { throw new Error('model down'); },
      async grade() { return { pass: true, reason: '' }; },
    });
    const out = await judge(judgeCase);
    assert.equal(out.status, 'fail');
    assert.match(out.detail, /model down/);
  });

  it('skips non-llm_judge probes', async () => {
    const judge = buildModelJudge({ async respond() { return ''; }, async grade() { return { pass: true, reason: '' }; } });
    const out = await judge({ name: 'x', category: 'file_handling', probe: { type: 'tool_presence', tool: 't', registered: true } });
    assert.equal(out.status, 'skip');
  });
});

describe('buildAresEvaluator with a judge', () => {
  it('routes llm_judge probes to the judge instead of skipping', async () => {
    const evaluate = buildAresEvaluator({
      registry: new ToolRegistry(),
      judge: async () => ({ status: 'pass', detail: 'judged' }),
    });
    const out = await evaluate(judgeCase);
    assert.equal(out.status, 'pass');
    assert.equal(out.detail, 'judged');
  });

  it('still skips llm_judge probes when no judge is provided', async () => {
    const evaluate = buildAresEvaluator({ registry: new ToolRegistry() });
    const out = await evaluate(judgeCase);
    assert.equal(out.status, 'skip');
  });
});
