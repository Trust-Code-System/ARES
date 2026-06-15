/**
 * Phase 3 — Tools + safety. All deterministic: the file tools run against a temp
 * workspace, the gate uses in-memory rule/queue stores and an injected prompter,
 * and web_search uses a fake provider. No network.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createFileTools } from '../src/tools/builtin/files.js';
import { createShellTool } from '../src/tools/builtin/shell.js';
import { createPythonTool } from '../src/tools/builtin/python.js';
import { createSystemActionTools, type SystemLauncher } from '../src/tools/builtin/systemActions.js';
import {
  createTradingTools,
  PaperBrokerProvider,
  AlpacaBrokerProvider,
  buildBrokerProvider,
  type BrokerProvider,
  type TradeFill,
} from '../src/tools/builtin/trading.js';
import { webFetch } from '../src/tools/builtin/webFetch.js';
import {
  assertPublicUrl,
  isBlockedIpv4,
  isBlockedIpv6,
  SsrfError,
} from '../src/tools/net/ssrf.js';
import {
  createWebSearchTool,
  GeminiGoogleSearchProvider,
  type SearchProvider,
} from '../src/tools/builtin/webSearch.js';
import { RuleBasedConfirmationGate } from '../src/safety/gate.js';
import {
  InMemoryConfirmationQueue,
  InMemoryRulesStore,
  evaluateRules,
  isSubset,
  type StandingRule,
} from '../src/safety/store.js';
import { InMemoryCostLedger, SpendCapEnforcer, type SpendConfig } from '../src/safety/caps.js';
import type { Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-test' };

function makeTool(name: string): Tool {
  return {
    name,
    description: 'test',
    kind: 'state_mutating',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { return { ok: true, content: 'ok' }; },
  };
}

function rule(partial: Partial<StandingRule> & Pick<StandingRule, 'tool' | 'effect'>): StandingRule {
  return {
    id: partial.id ?? 'rule',
    tool: partial.tool,
    match: partial.match ?? {},
    effect: partial.effect,
    reason: partial.reason ?? '',
    enabled: partial.enabled ?? true,
    createdAt: new Date().toISOString(),
    expiresAt: partial.expiresAt ?? null,
  };
}

describe('rule matching', () => {
  it('treats match as a deep subset of the input', () => {
    assert.equal(isSubset({ to: 'a@b.com' }, { to: 'a@b.com', subject: 'hi' }), true);
    assert.equal(isSubset({ to: 'a@b.com' }, { to: 'other@b.com' }), false);
    assert.equal(isSubset({}, { anything: 1 }), true);
    assert.equal(isSubset({ n: { deep: 1 } }, { n: { deep: 1, extra: 2 } }), true);
  });

  it('lets deny beat allow when both match', () => {
    const decision = evaluateRules(
      [rule({ tool: 'send_email', effect: 'allow' }), rule({ tool: 'send_email', effect: 'deny', reason: 'blocked' })],
      {},
    );
    assert.deepEqual(decision, { effect: 'deny', reason: 'blocked' });
  });

  it('returns null when nothing matches', () => {
    assert.equal(evaluateRules([rule({ tool: 'x', effect: 'allow', match: { a: 1 } })], { a: 2 }), null);
  });
});

describe('RuleBasedConfirmationGate', () => {
  const build = (mode: 'auto' | 'deny' | 'prompt', prompt?: (q: string) => Promise<string>) => {
    const rules = new InMemoryRulesStore();
    const queue = new InMemoryConfirmationQueue();
    const gate = new RuleBasedConfirmationGate({ mode, rules, queue, logger, ...(prompt ? { prompt } : {}) });
    return { gate, rules, queue };
  };

  it('honors auto and deny modes without consulting rules', async () => {
    assert.equal((await build('auto').gate.requestApproval(req())).approved, true);
    assert.equal((await build('deny').gate.requestApproval(req())).approved, false);
  });

  it('approves via a matching standing allow-rule with no prompt', async () => {
    const { gate, rules } = build('prompt', async () => 'n');
    await rules.add({ tool: 'send_email', effect: 'allow', reason: 'trusted' });
    const decision = await gate.requestApproval(req('send_email'));
    assert.equal(decision.approved, true);
    assert.match(decision.reason, /pre-authorized/);
  });

  it('"always" persists a standing rule so the user is not re-prompted', async () => {
    let prompts = 0;
    const { gate, rules } = build('prompt', async () => {
      prompts++;
      return prompts === 1 ? 'always' : 'no';
    });
    const first = await gate.requestApproval(req('write_file'));
    assert.equal(first.approved, true);
    assert.equal((await rules.list()).length, 1);

    const second = await gate.requestApproval(req('write_file'));
    assert.equal(second.approved, true);
    assert.equal(prompts, 1); // second decision came from the rule, not a prompt

    const differentInput = await gate.requestApproval(
      req('write_file', { to: 'different@example.com' }),
    );
    assert.equal(differentInput.approved, false);
    assert.equal(prompts, 2);
  });

  it('queues the request when no human is present', async () => {
    // No prompter + no TTY → the queue path. Force isTTY off so this is
    // deterministic even when the suite is run from an interactive terminal.
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const { gate, queue } = build('prompt');
      const decision = await gate.requestApproval(req('send_email'));
      assert.equal(decision.approved, false);
      assert.match(decision.reason, /queued for approval/);
      const pending = await queue.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.tool, 'send_email');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  function req(toolName = 'send_email', input: Record<string, unknown> = { to: 'a@b.com' }) {
    return { tool: makeTool(toolName), input, runId: 'run-1' };
  }
});

describe('spend caps', () => {
  const baseConfig = (over: Partial<SpendConfig> = {}): SpendConfig => ({
    rollingWindowMs: 1000,
    costFields: { pay: 'amount', place_trade: 'notional' },
    tradeToolMarkers: ['trade'],
    ...over,
  });

  it('reads cost only from the declared field; other tools cost nothing', async () => {
    const caps = new SpendCapEnforcer(baseConfig(), new InMemoryCostLedger());
    assert.equal(caps.cost(makeTool('pay'), { amount: 42 }), 42);
    assert.equal(caps.cost(makeTool('pay'), { amount: 'nope' }), 0);
    assert.equal(caps.cost(makeTool('send_email'), { amount: 999 }), 0); // not a costed tool
  });

  it('enforces the per-action limit', async () => {
    const caps = new SpendCapEnforcer(baseConfig({ perActionLimit: 100 }), new InMemoryCostLedger());
    assert.equal((await caps.check(makeTool('pay'), { amount: 50 })).ok, true);
    assert.equal((await caps.check(makeTool('pay'), { amount: 150 })).ok, false);
  });

  it('enforces a rolling-window limit and frees up as entries age out', async () => {
    let now = 1_000_000;
    const caps = new SpendCapEnforcer(
      baseConfig({ rollingLimit: 100, rollingWindowMs: 1000 }),
      new InMemoryCostLedger(),
      () => now,
    );
    const pay = makeTool('pay');
    assert.equal((await caps.check(pay, { amount: 60 })).ok, true);
    await caps.commit(pay, { amount: 60 });
    assert.equal((await caps.check(pay, { amount: 60 })).ok, false); // 60 + 60 > 100
    now += 2000; // the first spend falls outside the window
    assert.equal((await caps.check(pay, { amount: 60 })).ok, true);
  });

  it('applies a stricter notional cap to trade tools', async () => {
    const caps = new SpendCapEnforcer(baseConfig({ tradeNotionalCap: 1000 }), new InMemoryCostLedger());
    assert.equal((await caps.check(makeTool('place_trade'), { notional: 500 })).ok, true);
    assert.equal((await caps.check(makeTool('place_trade'), { notional: 5000 })).ok, false);
  });

  it('overrides even auto-approve mode in the gate (hard cap)', async () => {
    const caps = new SpendCapEnforcer(baseConfig({ perActionLimit: 100 }), new InMemoryCostLedger());
    const gate = new RuleBasedConfirmationGate({
      mode: 'auto',
      rules: new InMemoryRulesStore(),
      queue: new InMemoryConfirmationQueue(),
      logger,
      caps,
    });
    const over = await gate.requestApproval({ tool: makeTool('pay'), input: { amount: 500 }, runId: 'r' });
    assert.equal(over.approved, false);
    assert.match(over.reason, /hard spend cap/);
    // A call under the cap still rides the auto-approve path.
    const under = await gate.requestApproval({ tool: makeTool('pay'), input: { amount: 5 }, runId: 'r' });
    assert.equal(under.approved, true);
  });
});

describe('sandboxed file tools', () => {
  async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'ares-ws-'));
    const [readTool, writeTool, listTool] = createFileTools(root);
    return { root, readTool: readTool!, writeTool: writeTool!, listTool: listTool! };
  }

  it('writes then reads a file inside the workspace', async () => {
    const { root, readTool, writeTool } = await setup();
    const w = await writeTool.execute({ path: 'notes/todo.txt', content: 'buy milk' }, ctx);
    assert.equal(w.ok, true);
    assert.equal(await readFile(path.join(root, 'notes/todo.txt'), 'utf8'), 'buy milk');

    const r = await readTool.execute({ path: 'notes/todo.txt' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.content, 'buy milk');
  });

  it('rejects paths that escape the sandbox', async () => {
    const { readTool, writeTool } = await setup();
    await assert.rejects(readTool.execute({ path: '../../etc/passwd' }, ctx), /escapes the workspace/);
    await assert.rejects(
      writeTool.execute({ path: path.resolve('/tmp/evil.txt'), content: 'x' }, ctx),
      /escapes the workspace/,
    );
  });

  it('lists directory entries with trailing slashes for dirs', async () => {
    const { root, listTool } = await setup();
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'a.txt'), 'x');
    const res = await listTool.execute({}, ctx);
    assert.equal(res.content, 'a.txt\nsub/');
  });

  it('classifies write as state_mutating and reads as read_only', async () => {
    const { readTool, writeTool, listTool } = await setup();
    assert.equal(writeTool.kind, 'state_mutating');
    assert.equal(readTool.kind, 'read_only');
    assert.equal(listTool.kind, 'read_only');
  });
});

describe('sandboxed shell tool', () => {
  const shell = (allow = ['node']) =>
    createShellTool({ workspaceDir: process.cwd(), allowlist: allow, timeoutMs: 5000, maxOutputBytes: 64 * 1024 });

  it('is state_mutating (so it is always gated)', () => {
    assert.equal(shell().kind, 'state_mutating');
  });

  it('refuses a non-allowlisted program and any path-y command name', async () => {
    const notAllowed = await shell(['node']).execute({ command: 'rm', args: ['-rf', '/'] }, ctx);
    assert.equal(notAllowed.ok, false);
    assert.match(notAllowed.content, /not allowlisted/);

    const pathy = await shell(['node']).execute({ command: '../evil', args: [] }, ctx);
    assert.equal(pathy.ok, false);
    assert.match(pathy.content, /bare program name/);
  });

  it('runs an allowlisted program and captures stdout + exit code', async () => {
    const res = await shell(['node']).execute(
      { command: 'node', args: ['-e', 'process.stdout.write("hi from node")'] },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.match(res.content, /hi from node/);
    assert.equal((res.data as { exitCode: number }).exitCode, 0);
  });

  it('reports a non-zero exit as ok:false', async () => {
    const res = await shell(['node']).execute({ command: 'node', args: ['-e', 'process.exit(3)'] }, ctx);
    assert.equal(res.ok, false);
    assert.equal((res.data as { exitCode: number }).exitCode, 3);
  });

  it('kills a command that exceeds the timeout', async () => {
    const fast = createShellTool({ workspaceDir: process.cwd(), allowlist: ['node'], timeoutMs: 200, maxOutputBytes: 1024 });
    const res = await fast.execute({ command: 'node', args: ['-e', 'setTimeout(()=>{}, 10000)'] }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /timed out/);
  });
});

describe('Python execution tool', () => {
  it('is gated and executes isolated Python code', async () => {
    const tool = createPythonTool({
      workspaceDir: process.cwd(),
      command: process.platform === 'win32' ? 'python' : 'python3',
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
    assert.equal(tool.kind, 'state_mutating');
    const result = await tool.execute({ code: 'print(7 * 8)' }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /56/);
  });
});

describe('system action tools', () => {
  it('validate URLs and delegate approved launches', async () => {
    const opened: string[] = [];
    const launcher: SystemLauncher = {
      applications: ['calculator'],
      async openApplication(name) { opened.push(`app:${name}`); },
      async openUrl(url) { opened.push(`url:${url}`); },
    };
    const [app, url] = createSystemActionTools(launcher);
    assert.equal(app!.kind, 'state_mutating');
    assert.equal(url!.kind, 'state_mutating');
    assert.equal((await app!.execute({ application: 'calculator' }, ctx)).ok, true);
    assert.equal((await url!.execute({ url: 'https://example.com' }, ctx)).ok, true);
    assert.equal((await url!.execute({ url: 'file:///etc/passwd' }, ctx)).ok, false);
    assert.deepEqual(opened, ['app:calculator', 'url:https://example.com/']);
  });
});

describe('trading tools', () => {
  const tools = (cash = 100_000) => {
    const [positions, balance, trade] = createTradingTools(new PaperBrokerProvider({ startingCash: cash }));
    return { positions: positions!, balance: balance!, trade: trade! };
  };

  it('classifies reads as read-only and place_trade as state-mutating', () => {
    const { positions, balance, trade } = tools();
    assert.equal(positions.kind, 'read_only');
    assert.equal(balance.kind, 'read_only');
    assert.equal(trade.kind, 'state_mutating');
    assert.equal(trade.name, 'place_trade'); // matches the spend-cap notional field/markers
  });

  it('place_trade updates positions and balance via the paper broker', async () => {
    const { positions, balance, trade } = tools(100_000);
    const res = await trade.execute({ symbol: 'AAPL', side: 'buy', quantity: 10, notional: 2000 }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /Trade filled: buy 10 AAPL/);

    const bal = await balance.execute({}, ctx);
    assert.match(bal.content, /98000 USD/); // 100000 - 2000

    const pos = await positions.execute({}, ctx);
    assert.match(pos.content, /AAPL: 10 @ 200/);
  });

  it('rejects a non-positive quantity or notional', async () => {
    const { trade } = tools();
    const res = await trade.execute({ symbol: 'AAPL', side: 'buy', quantity: 0, notional: 100 }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /positive/);
  });

  it('treats an async-accepted order as ok but a rejected one as failed', async () => {
    const provider = (status: string): BrokerProvider => ({
      name: 'fake',
      async getPositions() { return []; },
      async getBalance() { return { cash: 0, currency: 'USD' }; },
      async placeTrade(o): Promise<TradeFill> {
        return { orderId: 'o1', symbol: o.symbol, side: o.side, quantity: o.quantity, notional: o.notional, status };
      },
    });
    const accepted = createTradingTools(provider('accepted'))[2]!;
    const rejected = createTradingTools(provider('rejected'))[2]!;
    const order = { symbol: 'AAPL', side: 'buy', quantity: 1, notional: 100 };
    assert.equal((await accepted.execute(order, ctx)).ok, true);
    assert.equal((await rejected.execute(order, ctx)).ok, false);
  });
});

describe('AlpacaBrokerProvider', () => {
  function fakeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = routes[path] ?? { status: 404, text: 'not found' };
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('maps positions and balance from the Alpaca account API', async () => {
    const { impl } = fakeFetch({
      '/v2/positions': { json: [{ symbol: 'AAPL', qty: '3', avg_entry_price: '190.5' }] },
      '/v2/account': { json: { cash: '12345.6789', currency: 'USD' } },
    });
    const broker = new AlpacaBrokerProvider({ keyId: 'k', secretKey: 's', fetchImpl: impl });

    assert.deepEqual(await broker.getPositions(), [{ symbol: 'AAPL', quantity: 3, averagePrice: 190.5 }]);
    assert.deepEqual(await broker.getBalance(), { cash: 12345.68, currency: 'USD' });
  });

  it('submits a market order with auth headers and returns the fill', async () => {
    const { impl, calls } = fakeFetch({
      '/v2/orders': { json: { id: 'ord_1', symbol: 'AAPL', side: 'buy', qty: '2', status: 'accepted' } },
    });
    const broker = new AlpacaBrokerProvider({ keyId: 'KID', secretKey: 'SEC', fetchImpl: impl });
    const fill = await broker.placeTrade({ symbol: 'AAPL', side: 'buy', quantity: 2, notional: 380 });

    assert.equal(fill.orderId, 'ord_1');
    assert.equal(fill.status, 'accepted');
    assert.equal(fill.notional, 380); // carried through from the order, not the API
    const post = calls.find((c) => c.url.endsWith('/v2/orders'))!;
    assert.equal(post.method, 'POST');
    assert.equal(post.headers['APCA-API-KEY-ID'], 'KID');
    assert.equal(post.headers['APCA-API-SECRET-KEY'], 'SEC');
    assert.deepEqual(post.body, { symbol: 'AAPL', qty: '2', side: 'buy', type: 'market', time_in_force: 'day' });
  });

  it('defaults to the paper endpoint and throws on an API error', async () => {
    const { impl, calls } = fakeFetch({ '/v2/account': { status: 403, text: 'forbidden' } });
    const broker = new AlpacaBrokerProvider({ keyId: 'k', secretKey: 's', fetchImpl: impl });
    await assert.rejects(() => broker.getBalance(), /403/);
    assert.match(calls[0]!.url, /^https:\/\/paper-api\.alpaca\.markets\//);
  });
});

describe('buildBrokerProvider', () => {
  const base = { broker: 'paper' as const, startingCash: 100_000 };

  it('returns undefined when trading is disabled', () => {
    assert.equal(buildBrokerProvider({ ...base, enabled: false }), undefined);
  });

  it('builds the paper broker by default and Alpaca when selected with creds', () => {
    assert.equal(buildBrokerProvider({ ...base, enabled: true })!.name, 'paper');
    const alpaca = buildBrokerProvider({ enabled: true, broker: 'alpaca', startingCash: 0, alpaca: { keyId: 'k', secretKey: 's' } });
    assert.equal(alpaca!.name, 'alpaca');
  });

  it('fails fast if alpaca is selected without credentials', () => {
    assert.throws(() => buildBrokerProvider({ enabled: true, broker: 'alpaca', startingCash: 0 }), /requires ALPACA/);
  });
});

describe('web_fetch validation', () => {
  it('rejects non-URLs and non-http(s) schemes without hitting the network', async () => {
    assert.equal((await webFetch.execute({ url: 'not a url' }, ctx)).ok, false);
    assert.equal((await webFetch.execute({ url: 'file:///etc/passwd' }, ctx)).ok, false);
    assert.equal((await webFetch.execute({ url: 'ftp://example.com' }, ctx)).ok, false);
  });

  it('blocks a literal private/loopback target without hitting the network', async () => {
    // assertPublicUrl rejects the literal IP before any fetch is attempted.
    const loop = await webFetch.execute({ url: 'http://127.0.0.1/' }, ctx);
    assert.equal(loop.ok, false);
    assert.match(loop.content, /SSRF guard/);
    const meta = await webFetch.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
    assert.equal(meta.ok, false);
    assert.match(meta.content, /SSRF guard/);
  });
});

describe('SSRF guard', () => {
  it('classifies IPv4 private/reserved ranges as blocked', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0'])
      assert.equal(isBlockedIpv4(ip), true, ip);
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1'])
      assert.equal(isBlockedIpv4(ip), false, ip);
  });

  it('classifies IPv6 loopback/link-local/ULA and IPv4-mapped as blocked', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::'])
      assert.equal(isBlockedIpv6(ip), true, ip);
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888'])
      assert.equal(isBlockedIpv6(ip), false, ip);
  });

  it('blocks a hostname that resolves to a private address, allows a public one', async () => {
    const toPrivate = async () => [{ address: '10.1.2.3', family: 4 }];
    await assert.rejects(assertPublicUrl(new URL('http://intranet.example/'), toPrivate), SsrfError);

    const toPublic = async () => [{ address: '93.184.216.34', family: 4 }];
    await assert.doesNotReject(assertPublicUrl(new URL('http://example.com/'), toPublic));
  });

  it('blocks when ANY resolved address is private (DNS multi-record)', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await assert.rejects(assertPublicUrl(new URL('http://rebind.example/'), mixed), SsrfError);
  });
});

describe('web_search', () => {
  const provider: SearchProvider = {
    name: 'fake',
    async search(query, max) {
      return Array.from({ length: max }, (_, i) => ({
        title: `Result ${i} for ${query}`,
        url: `https://example.com/${i}`,
        snippet: 'snippet',
      }));
    },
  };

  it('clamps max_results into [1,10] and formats hits', async () => {
    const tool = createWebSearchTool(provider);
    const res = await tool.execute({ query: 'ares', max_results: 99 }, ctx);
    assert.equal(res.ok, true);
    assert.equal((res.data as { results: unknown[] }).results.length, 10);
    assert.match(res.content, /1\. Result 0 for ares/);
  });

  it('defaults max_results when omitted', async () => {
    const tool = createWebSearchTool(provider);
    const res = await tool.execute({ query: 'x' }, ctx);
    assert.equal((res.data as { results: unknown[] }).results.length, 5);
  });

  it('extracts deduplicated Google grounding sources', async () => {
    const sdk = {
      models: {
        async generateContent() {
          return {
            get text() { return 'A grounded digest.'; },
            candidates: [{
              groundingMetadata: {
                groundingChunks: [
                  { web: { title: 'One', uri: 'https://example.com/one' } },
                  { web: { title: 'One duplicate', uri: 'https://example.com/one' } },
                  { web: { title: 'Two', uri: 'https://example.com/two' } },
                ],
              },
            }],
          };
        },
      },
    };
    const provider = new GeminiGoogleSearchProvider('test', 'gemini-test', sdk as never);
    const results = await provider.search('current topic', 2);
    assert.deepEqual(results.map((result) => result.title), ['One', 'Two']);
    assert.match(results[0]!.snippet, /grounded digest/);
  });
});
