/**
 * Multi-agent workflow selection tests (Phase 11) — deterministic, offline.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

import { loadWorkflows, selectWorkflow } from '../src/agents/workflows.js';

const WORKFLOWS_DIR = path.resolve(process.cwd(), 'workflows');
const workflows = loadWorkflows(WORKFLOWS_DIR);

describe('workflows load', () => {
  it('loads the templates with stages', () => {
    assert.ok(workflows.length >= 7, `expected >=7 workflows, got ${workflows.length}`);
    for (const wf of workflows) assert.ok(wf.stages.length > 0, `${wf.id} has no stages`);
  });
});

describe('eval: workflow selection', () => {
  const cases: Array<[string, string]> = [
    ['Build this feature from idea to production', 'feature-build'],
    ['Run a security review on the auth flow', 'security-review'],
    ['Is this production ready to launch?', 'launch-readiness'],
    ['Help me fix this bug, it keeps crashing', 'bug-fix'],
    ['Prepare data to fine-tune Jarvis tone', 'fine-tuning'],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" → ${expected}`, () => {
      const wf = selectWorkflow(text, workflows);
      assert.equal(wf?.id, expected, `got: ${wf?.id ?? 'null'}`);
    });
  }

  it('the fine-tuning workflow requires a sensitive-data scan', () => {
    const wf = selectWorkflow('Prepare data to fine-tune Jarvis tone', workflows);
    assert.equal(wf?.requires_sensitive_data_scan, true);
  });

  it('returns null when nothing matches', () => {
    assert.equal(selectWorkflow('what is the capital of France', workflows), null);
  });
});
