/**
 * Phase 6 — browser / form-filling tools. Deterministic and offline: a FAKE
 * BrowserController stands in for Playwright, so the safety logic is exercised
 * with no real browser. The point of these tests is the safety boundary:
 *   - fill never types secrets, and never types into a sensitive field
 *   - submit is a separate, gated tool (no auto-submit hidden in click)
 *   - navigation is SSRF-guarded and http(s)-only
 *   - read/navigate are read_only; fill/click/submit are state_mutating
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBrowserTools,
  type BrowserController,
  type NavResult,
  type PageSnapshot,
} from '../src/tools/builtin/browser.js';
import type { Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-browser' };

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

/** Records calls; returns a canned snapshot with a normal field, a password field, and a submit button. */
class FakeController implements BrowserController {
  readonly calls: string[] = [];
  readonly filled: Array<{ ref: string; value: string }> = [];
  submitted = false;

  snapshotData: PageSnapshot = {
    url: 'https://example.com/signup',
    title: 'Sign up',
    text: 'Create your account',
    fields: [
      { ref: 'e0', tag: 'input', type: 'text', name: 'fullName', label: 'Full name', sensitive: false },
      { ref: 'e1', tag: 'input', type: 'password', name: 'password', label: 'Password', sensitive: true },
    ],
    buttons: [{ ref: 'e2', tag: 'button', type: 'submit', label: 'Create account', sensitive: false }],
  };

  async navigate(url: string): Promise<NavResult> {
    this.calls.push(`navigate:${url}`);
    return { url, title: 'Sign up' };
  }
  async snapshot(): Promise<PageSnapshot> {
    this.calls.push('snapshot');
    return this.snapshotData;
  }
  async fill(ref: string, value: string): Promise<void> {
    this.calls.push(`fill:${ref}`);
    this.filled.push({ ref, value });
  }
  async click(ref: string): Promise<void> {
    this.calls.push(`click:${ref}`);
  }
  async submit(ref: string | undefined): Promise<NavResult> {
    this.calls.push(`submit:${ref ?? ''}`);
    this.submitted = true;
    return { url: 'https://example.com/welcome', title: 'Welcome' };
  }
  async close(): Promise<void> {
    this.calls.push('close');
  }
}

describe('browser tools — kinds + surface', () => {
  const tools = createBrowserTools(new FakeController());
  it('navigate and read are read_only; fill/click/submit are state_mutating', () => {
    assert.equal(byName(tools, 'browser_navigate').kind, 'read_only');
    assert.equal(byName(tools, 'browser_read').kind, 'read_only');
    assert.equal(byName(tools, 'browser_fill').kind, 'state_mutating');
    assert.equal(byName(tools, 'browser_click').kind, 'state_mutating');
    assert.equal(byName(tools, 'browser_submit').kind, 'state_mutating');
  });
  it('submit is its own tool, separate from click (no auto-submit)', () => {
    assert.ok(tools.find((t) => t.name === 'browser_submit'));
    assert.ok(tools.find((t) => t.name === 'browser_click'));
  });
});

describe('browser_navigate — SSRF + protocol guard', () => {
  it('refuses a non-http protocol', async () => {
    const tools = createBrowserTools(new FakeController());
    const r = await byName(tools, 'browser_navigate').execute({ url: 'file:///etc/passwd' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /http/i);
  });
  it('refuses a loopback / private address (SSRF)', async () => {
    const tools = createBrowserTools(new FakeController());
    const r = await byName(tools, 'browser_navigate').execute({ url: 'http://127.0.0.1:8080/admin' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /SSRF|private|reserved/i);
  });
  it('refuses the cloud metadata endpoint', async () => {
    const tools = createBrowserTools(new FakeController());
    const r = await byName(tools, 'browser_navigate').execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
    assert.equal(r.ok, false);
  });
});

describe('browser_fill — never types secrets', () => {
  it('refuses a value that looks like a secret', async () => {
    const fake = new FakeController();
    const tools = createBrowserTools(fake);
    const r = await byName(tools, 'browser_fill').execute(
      { fields: [{ ref: 'e0', value: 'password: hunter2!' }] },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.equal(fake.filled.length, 0);
  });

  it('refuses to type into a sensitive (password) field even with a benign value', async () => {
    const fake = new FakeController();
    const tools = createBrowserTools(fake);
    // browser_read first so the tool knows e1 is sensitive.
    await byName(tools, 'browser_read').execute({}, ctx);
    const r = await byName(tools, 'browser_fill').execute(
      { fields: [{ ref: 'e1', value: 'whatever' }] },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.match(r.content, /sensitive/i);
    assert.equal(fake.filled.length, 0);
  });

  it('fills a normal field and does NOT submit', async () => {
    const fake = new FakeController();
    const tools = createBrowserTools(fake);
    await byName(tools, 'browser_read').execute({}, ctx);
    const r = await byName(tools, 'browser_fill').execute(
      { fields: [{ ref: 'e0', value: 'Ada Lovelace' }] },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.match(r.content, /Not submitted/i);
    assert.equal(fake.filled[0]!.value, 'Ada Lovelace');
    assert.equal(fake.submitted, false);
  });
});

describe('browser_submit', () => {
  it('submits and reports the resulting page', async () => {
    const fake = new FakeController();
    const tools = createBrowserTools(fake);
    const r = await byName(tools, 'browser_submit').execute({ ref: 'e2' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(fake.submitted, true);
    assert.match(r.content, /welcome/i);
  });
});

describe('guard — missing browser binary', () => {
  it('returns an install hint instead of throwing', async () => {
    const broken: BrowserController = {
      async navigate() { throw new Error("Executable doesn't exist at /ms-playwright/chromium; run playwright install"); },
      async snapshot() { throw new Error('x'); },
      async fill() {}, async click() {}, async submit() { return { url: '', title: '' }; }, async close() {},
    };
    const tools = createBrowserTools(broken);
    const r = await byName(tools, 'browser_navigate').execute({ url: 'https://example.com' }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /playwright install/i);
  });
});
