/**
 * Agent routing eval (Phase 11) — deterministic, offline.
 *
 * Asserts that real requests reach the expected specialist via selectAgents over
 * the REAL vendored persona library. No network or model calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

import { loadAgentIndex } from '../src/agents/loader.js';
import { selectAgents } from '../src/agents/router.js';

const AGENTS_DIR = path.resolve(process.cwd(), 'agents');
const idx = loadAgentIndex(AGENTS_DIR);

describe('agent library loads', () => {
  it('discovers the curated personas', () => {
    assert.ok(idx.size >= 15, `expected >=15 agents, got ${idx.size}`);
    assert.ok(idx.get('security/security-engineer'), 'security-engineer should load');
  });
});

describe('eval: agent routing', () => {
  it('"Make this dashboard look premium" → a design/frontend specialist', () => {
    const r = selectAgents('Make this dashboard look premium', idx);
    const selected = [r.primary_agent, ...r.supporting_agents];
    assert.ok(
      selected.includes('design/ui-designer') || selected.includes('engineering/frontend-developer'),
      `expected ui-designer or frontend-developer, got: ${selected.join(', ')}`,
    );
    assert.equal(r.risk_level, 'low');
    assert.equal(r.needs_confirmation, false);
  });

  it('"Check if this auth system is safe" → security-engineer, medium risk, needs confirmation', () => {
    const r = selectAgents('Check if this authentication system is safe', idx);
    assert.equal(r.primary_agent, 'security/security-engineer');
    assert.equal(r.risk_level, 'medium');
    assert.equal(r.needs_confirmation, true);
  });

  it('"Prepare data to fine-tune Jarvis tone" → an AI specialist', () => {
    const r = selectAgents('Prepare data to fine-tune Jarvis tone', idx);
    assert.ok(r.primary_agent?.startsWith('ai/'), `expected an ai/* agent, got: ${r.primary_agent}`);
  });

  it('carries skills/tools and a model provider, and a sensible intent', () => {
    const r = selectAgents('Make this dashboard look premium', idx);
    assert.ok(['anthropic', 'openai', 'gemini'].includes(r.model));
    assert.match(r.intent, /:[a-z]+$/);
  });

  it('returns a null primary with a graceful general fallback for gibberish', () => {
    const r = selectAgents('zxqwv plover frobnicate', idx);
    assert.equal(r.primary_agent, null);
    assert.equal(r.supporting_agents.length, 0);
    assert.equal(r.needs_confirmation, false);
  });
});
