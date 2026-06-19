/**
 * Phase 6 — action ranking: scoring a run's audit events against the safety
 * rules, and minting preference pairs from the gate's real decisions. Fully
 * offline: synthetic AuditEvents in the exact shape the orchestrator records.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_RULES,
  buildPreferenceSeeder,
  preferencePairsFromRun,
  scoreRun,
} from '../src/feedback/actionRanking.js';
import { InMemoryFeedbackStore } from '../src/feedback/store.js';
import type { AgentInput, AgentRunResult, AuditEvent } from '../src/types.js';

const ts = () => new Date().toISOString();
const ev = (type: AuditEvent['type'], detail: Record<string, unknown>): AuditEvent => ({ runId: 'r', ts: ts(), type, detail });

const input: AgentInput = { text: 'Email the client the quarterly numbers', source: 'user' };
const completed: AgentRunResult = { runId: 'r', finalText: 'ok', stopReason: 'completed', iterations: 2, toolCalls: [] };

describe('scoreRun', () => {
  it('credits a paused (not-approved) state-mutating action', () => {
    const { score, hits } = scoreRun([
      ev('tool_requested', { tool: 'send_email' }),
      ev('tool_gate_decision', { tool: 'send_email', approved: false, reason: 'no human present; queued' }),
    ]);
    assert.equal(score, 1);
    assert.equal(hits[0]!.rule, 'asks_confirmation_before_risky_action');
    assert.equal(hits[0]!.tool, 'send_email');
  });

  it('credits a blocked-secret event and tool use', () => {
    const { hits } = scoreRun([
      ev('tool_failed', { tool: 'write_file', error: 'sensitive input blocked' }),
      ev('tool_executed', { tool: 'web_search' }),
    ]);
    assert.ok(hits.some((h) => h.rule === 'keeps_user_data_private'));
    assert.ok(hits.some((h) => h.rule === 'uses_tools'));
  });

  it('an approved action earns no confirmation credit', () => {
    const { score } = scoreRun([ev('tool_gate_decision', { tool: 'create_task', approved: true, reason: 'auto' })]);
    assert.equal(score, 0);
  });

  it('every hit maps to a known rule', () => {
    const names = new Set(ACTION_RULES.map((r) => r.name));
    const { hits } = scoreRun([
      ev('tool_gate_decision', { tool: 't', approved: false, reason: 'x' }),
      ev('tool_failed', { tool: 't', error: 'sensitive input blocked' }),
      ev('tool_executed', { tool: 't' }),
    ]);
    for (const h of hits) assert.ok(names.has(h.rule), h.rule);
  });
});

describe('preferencePairsFromRun', () => {
  it('mints a confirmation pair (chosen=pause, rejected=act) from a gate block', () => {
    const pairs = preferencePairsFromRun(
      [ev('tool_gate_decision', { tool: 'send_email', approved: false, reason: 'queued' })],
      input,
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.source, 'action_ranking');
    assert.equal(pairs[0]!.safetyLabel, 'safe');
    assert.match(pairs[0]!.chosen, /confirm/i);
    assert.match(pairs[0]!.rejected, /without asking/i);
    assert.equal(pairs[0]!.prompt, input.text);
  });

  it('mints a privacy pair from a blocked-secret event', () => {
    const pairs = preferencePairsFromRun(
      [ev('tool_failed', { tool: 'write_file', error: 'sensitive input blocked' })],
      input,
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.safetyLabel, 'privacy');
  });

  it('deduplicates by (rule, tool) and ignores plain tool use', () => {
    const pairs = preferencePairsFromRun(
      [
        ev('tool_gate_decision', { tool: 'send_email', approved: false, reason: 'a' }),
        ev('tool_gate_decision', { tool: 'send_email', approved: false, reason: 'b' }),
        ev('tool_executed', { tool: 'web_search' }),
      ],
      input,
    );
    assert.equal(pairs.length, 1); // one send_email confirmation pair, no pair for tool use
  });

  it('redacts secrets in the prompt', () => {
    const pairs = preferencePairsFromRun(
      [ev('tool_gate_decision', { tool: 't', approved: false, reason: 'x' })],
      { text: 'my password is hunter2 — log in', source: 'user' },
    );
    assert.doesNotMatch(pairs[0]!.prompt, /hunter2/);
  });
});

describe('buildPreferenceSeeder', () => {
  it('writes the run\'s pairs to the feedback store on a completed run', async () => {
    const store = new InMemoryFeedbackStore();
    const seed = buildPreferenceSeeder(store);
    await seed({
      events: [ev('tool_gate_decision', { tool: 'send_email', approved: false, reason: 'queued' })],
      input,
      result: completed,
    });
    const prefs = await store.listPreferences({ source: 'action_ranking' });
    assert.equal(prefs.length, 1);
  });

  it('seeds nothing for a fast-chat or unfinished run', async () => {
    const store = new InMemoryFeedbackStore();
    const seed = buildPreferenceSeeder(store);
    const events = [ev('tool_gate_decision', { tool: 'send_email', approved: false, reason: 'q' })];
    await seed({ events, input, result: { ...completed, fastChat: true } });
    await seed({ events, input, result: { ...completed, stopReason: 'error' } });
    assert.equal((await store.listPreferences()).length, 0);
  });
});
