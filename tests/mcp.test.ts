/**
 * MCP bridge — classification + import wrapping. Deterministic and offline: a
 * FakeMcpClient stands in for a real server, so no subprocess and no network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyMcpTool, firstToken } from '../src/mcp/classify.js';
import { importMcpTools } from '../src/mcp/bridge.js';
import { FakeMcpClient, type McpToolDescriptor } from '../src/mcp/client.js';
import {
  SdkMcpClient,
  mcpToolToDescriptor,
  mcpResultToCallResult,
  flattenContent,
} from '../src/mcp/sdkClient.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import type { Logger, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-mcp' };

const descriptors: McpToolDescriptor[] = [
  { name: 'list_messages', description: 'List inbox messages', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'send_email', description: 'Send an email', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
  { name: 'createEvent', description: 'Create a calendar event', inputSchema: { type: 'object', properties: {} } },
  { name: 'weird_verb_thing', description: 'unknown verb', inputSchema: { type: 'object', properties: {} } },
];

describe('classifyMcpTool', () => {
  it('extracts the leading verb across snake/kebab/camelCase', () => {
    assert.equal(firstToken('list_messages'), 'list');
    assert.equal(firstToken('createEvent'), 'create');
    assert.equal(firstToken('get-thread'), 'get');
  });

  it('marks read verbs read_only and everything else state_mutating (fail-safe)', () => {
    assert.equal(classifyMcpTool('list_messages'), 'read_only');
    assert.equal(classifyMcpTool('search_threads'), 'read_only');
    assert.equal(classifyMcpTool('send_email'), 'state_mutating');
    assert.equal(classifyMcpTool('createEvent'), 'state_mutating');
    assert.equal(classifyMcpTool('weird_verb_thing'), 'state_mutating'); // unknown → gated
  });

  it('honors explicit overrides', () => {
    assert.equal(classifyMcpTool('list_messages', { list_messages: 'state_mutating' }), 'state_mutating');
    assert.equal(classifyMcpTool('send_email', { send_email: 'read_only' }), 'read_only');
  });

  it('treats known pure-reasoning tools as read_only despite no read verb', () => {
    assert.equal(classifyMcpTool('sequentialthinking'), 'read_only');
    assert.equal(classifyMcpTool('sequential_thinking'), 'read_only');
    assert.equal(classifyMcpTool('sequentialThinking'), 'read_only');
    // An explicit override still wins over the built-in default.
    assert.equal(classifyMcpTool('sequentialthinking', { sequentialthinking: 'state_mutating' }), 'state_mutating');
  });
});

describe('importMcpTools', () => {
  async function importAll() {
    const client = new FakeMcpClient('gmail', descriptors);
    await client.connect();
    return importMcpTools({ client, namespace: 'gmail', logger });
  }

  it('namespaces names, classifies kind, and marks them non-strict', async () => {
    const tools = await importAll();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    assert.ok(byName.gmail_list_messages);
    assert.equal(byName.gmail_list_messages!.kind, 'read_only');
    assert.equal(byName.gmail_send_email!.kind, 'state_mutating');
    assert.equal(byName.gmail_createEvent!.kind, 'state_mutating');
    // Imported tools opt out of strict schema mode.
    assert.equal(byName.gmail_send_email!.strict, false);
  });

  it('forwards execute to the server and maps an error result to ok:false', async () => {
    const client = new FakeMcpClient('gmail', descriptors, (name, args) => {
      if (name === 'send_email') return { content: 'quota exceeded', isError: true };
      return { content: `ok:${name}`, isError: false, data: args };
    });
    await client.connect();
    const tools = await importMcpTools({ client, namespace: 'gmail', logger });
    const list = tools.find((t) => t.name === 'gmail_list_messages')!;
    const send = tools.find((t) => t.name === 'gmail_send_email')!;

    const okRes = await list.execute({ q: 'is:unread' }, ctx);
    assert.equal(okRes.ok, true);
    assert.match(okRes.content, /ok:list_messages/);

    const errRes = await send.execute({ to: 'a@b.com' }, ctx);
    assert.equal(errRes.ok, false);
    assert.match(errRes.content, /quota exceeded/);
  });

  it('registers cleanly alongside the built-ins via extraTools', async () => {
    const tools = await importAll();
    const registry = createDefaultRegistry({ workspaceDir: process.cwd(), extraTools: tools });
    // A mutating MCP tool is in the catalog and will be gated by the orchestrator.
    assert.equal(registry.has('gmail_send_email'), true);
    assert.equal(registry.get('gmail_send_email')!.kind, 'state_mutating');
    // Built-ins still present.
    assert.equal(registry.has('web_fetch'), true);
  });
});

describe('SdkMcpClient mappers', () => {
  it('maps an SDK tool descriptor with defaults for missing fields', () => {
    assert.deepEqual(mcpToolToDescriptor({ name: 'get_thread', description: 'd', inputSchema: { type: 'object', properties: { id: {} } } }), {
      name: 'get_thread',
      description: 'd',
      inputSchema: { type: 'object', properties: { id: {} } },
    });
    // Missing description/schema fall back to safe defaults.
    const bare = mcpToolToDescriptor({ name: 'ping' });
    assert.equal(bare.description, '');
    assert.deepEqual(bare.inputSchema, { type: 'object', properties: {} });
  });

  it('maps a call result: flattens content, coerces isError, carries structured data', () => {
    const res = mcpResultToCallResult({
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', data: '…' }],
      isError: 1,
      structuredContent: { ok: true },
    });
    assert.equal(res.content, 'a\nb\n[image]');
    assert.equal(res.isError, true);
    assert.deepEqual(res.data, { ok: true });

    // A bare/empty response degrades gracefully.
    const empty = mcpResultToCallResult(undefined);
    assert.deepEqual(empty, { content: '', isError: false, data: undefined });
  });

  it('flattenContent handles non-array and empty inputs', () => {
    assert.equal(flattenContent('not an array'), '');
    assert.equal(flattenContent([]), '');
    assert.equal(flattenContent([{ type: 'text', text: ' hi ' }]), 'hi');
  });

  it('refuses to list/call tools before connect (no subprocess spawned)', async () => {
    const client = new SdkMcpClient({ name: 'gmail', command: 'node', args: ['nonexistent.js'] });
    assert.equal(client.serverName, 'gmail');
    await assert.rejects(() => client.listTools(), /not connected/);
    await assert.rejects(() => client.callTool('x', {}), /not connected/);
  });
});
