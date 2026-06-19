/**
 * Phase 6 — email tools. Offline: draft_email returns a draft and never sends;
 * send_email is gated, registered only when a sender is configured, and routes
 * through an injected fake transport (no real SMTP).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEmailTools, formatDraft, type EmailMessage, type EmailSender } from '../src/tools/builtin/email.js';
import type { Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-email' };

function byName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

describe('formatDraft', () => {
  it('renders headers and body, omitting empty cc/bcc', () => {
    const out = formatDraft({ to: 'a@x.com', subject: 'Hi', body: 'Hello' });
    assert.match(out, /^To: a@x\.com/);
    assert.match(out, /Subject: Hi/);
    assert.doesNotMatch(out, /Cc:/);
  });
});

describe('draft_email', () => {
  const tools = createEmailTools();
  const draft = byName(tools, 'draft_email')!;

  it('is read_only and always registered', () => {
    assert.equal(draft.kind, 'read_only');
  });

  it('returns a draft without sending', async () => {
    const r = await draft.execute({ to: 'client@acme.com', subject: 'Q3', body: 'Numbers attached.' }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /not sent/i);
    assert.match(r.content, /client@acme\.com/);
  });

  it('rejects a non-email recipient', async () => {
    const r = await draft.execute({ to: 'not-an-email', subject: 's', body: 'b' }, ctx);
    assert.equal(r.ok, false);
  });
});

describe('send_email', () => {
  it('is NOT registered without a configured sender', () => {
    assert.equal(byName(createEmailTools(), 'send_email'), undefined);
  });

  it('is registered and gated when a sender is configured', () => {
    const send = byName(createEmailTools({ sender: async () => ({ id: 'x' }) }), 'send_email')!;
    assert.equal(send.kind, 'state_mutating');
  });

  it('sends via the injected transport and reports the id', async () => {
    const sent: EmailMessage[] = [];
    const sender: EmailSender = async (msg) => { sent.push(msg); return { id: 'msg-1' }; };
    const send = byName(createEmailTools({ sender }), 'send_email')!;
    const r = await send.execute({ to: 'client@acme.com', subject: 'Q3', body: 'Hi', cc: 'boss@acme.com' }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.content, /msg-1/);
    assert.equal(sent[0]!.to, 'client@acme.com');
    assert.equal(sent[0]!.cc, 'boss@acme.com');
  });

  it('rejects a non-email recipient before sending', async () => {
    let called = false;
    const send = byName(createEmailTools({ sender: async () => { called = true; return { id: 'x' }; } }), 'send_email')!;
    const r = await send.execute({ to: 'nope', subject: 's', body: 'b' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });
});
