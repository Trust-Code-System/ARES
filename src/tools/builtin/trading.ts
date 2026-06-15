/**
 * Trading tools — read positions/balance freely; place trades only behind the gate.
 *
 * Design mirrors web_search: a pluggable {@link BrokerProvider} backs the tools, so
 * a real broker (Alpaca, IBKR, …) is a drop-in, and the offline
 * {@link PaperBrokerProvider} lets everything run and be tested with zero infra.
 *
 * Safety is layered and code-level, never prompt-level:
 *   - `get_positions` / `get_balance` are read-only (no gate).
 *   - `place_trade` is state-mutating → routed through the confirmation gate, so a
 *     human approves it (or it queues when unattended).
 *   - `place_trade` carries a `notional`, which the {@link SpendCapEnforcer} reads:
 *     a trade above `ARES_TRADE_NOTIONAL_CAP` is denied in code before it can run,
 *     and it also counts against the rolling spend limit.
 *
 * Off by default (enabled via `ARES_TRADING_ENABLED=true`).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
}

export interface Balance {
  cash: number;
  currency: string;
}

export interface TradeOrder {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** Total cash value of the order; the cap enforcer reads this field. */
  notional: number;
}

export interface TradeFill {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  notional: number;
  status: string;
}

export interface BrokerProvider {
  readonly name: string;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<Balance>;
  placeTrade(order: TradeOrder): Promise<TradeFill>;
}

/** In-memory paper broker: deterministic, no network, the dev/test default. */
export class PaperBrokerProvider implements BrokerProvider {
  readonly name = 'paper';
  private cash: number;
  private readonly positions = new Map<string, Position>();

  constructor(opts: { startingCash?: number } = {}) {
    this.cash = opts.startingCash ?? 100_000;
  }

  async getBalance(): Promise<Balance> {
    return { cash: round2(this.cash), currency: 'USD' };
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions.values()];
  }

  async placeTrade(order: TradeOrder): Promise<TradeFill> {
    const sign = order.side === 'buy' ? 1 : -1;
    this.cash -= sign * order.notional; // buying spends cash, selling adds it
    const price = order.quantity > 0 ? order.notional / order.quantity : 0;
    const existing = this.positions.get(order.symbol);
    const newQty = (existing?.quantity ?? 0) + sign * order.quantity;
    if (Math.abs(newQty) < 1e-9) this.positions.delete(order.symbol);
    else this.positions.set(order.symbol, { symbol: order.symbol, quantity: newQty, averagePrice: round2(price) });
    return {
      orderId: randomUUID(),
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      notional: order.notional,
      status: 'filled',
    };
  }
}

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  /** Defaults to the paper endpoint; set the live host to trade real money. */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Real broker over Alpaca's trading API (v2). Defaults to the PAPER endpoint, so
 * it's safe unless pointed at the live host. Speaks only the {@link BrokerProvider}
 * contract — the tools, gate, and caps are unchanged whether this or the paper
 * broker is wired. Money safety still comes from the gate + the trade notional cap;
 * this just executes an already-approved order.
 */
export class AlpacaBrokerProvider implements BrokerProvider {
  readonly name = 'alpaca';
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AlpacaOptions) {
    this.keyId = opts.keyId;
    this.secretKey = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getPositions(): Promise<Position[]> {
    const rows = await this.request<AlpacaPosition[]>('GET', '/v2/positions');
    return rows.map((p) => ({
      symbol: p.symbol,
      quantity: Number(p.qty),
      averagePrice: round2(Number(p.avg_entry_price)),
    }));
  }

  async getBalance(): Promise<Balance> {
    const acct = await this.request<AlpacaAccount>('GET', '/v2/account');
    return { cash: round2(Number(acct.cash)), currency: acct.currency ?? 'USD' };
  }

  async placeTrade(order: TradeOrder): Promise<TradeFill> {
    // Submit a market order by share quantity. Alpaca returns an accepted order
    // that fills asynchronously, so the status is typically "accepted"/"new"
    // rather than "filled"; the tool treats anything not explicitly rejected as ok.
    const res = await this.request<AlpacaOrder>('POST', '/v2/orders', {
      symbol: order.symbol,
      qty: String(order.quantity),
      side: order.side,
      type: 'market',
      time_in_force: 'day',
    });
    return {
      orderId: res.id,
      symbol: res.symbol,
      side: res.side,
      quantity: Number(res.qty),
      notional: order.notional,
      status: res.status,
    };
  }

  private async request<R>(method: string, path: string, body?: unknown): Promise<R> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Alpaca ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return (await res.json()) as R;
  }
}

interface AlpacaPosition { symbol: string; qty: string; avg_entry_price: string }
interface AlpacaAccount { cash: string; currency?: string }
interface AlpacaOrder { id: string; symbol: string; side: 'buy' | 'sell'; qty: string; status: string }

export function createTradingTools(provider: BrokerProvider): Tool[] {
  const getPositions = defineTool({
    name: 'get_positions',
    description: 'List current brokerage positions (symbol, quantity, average price). Read-only.',
    kind: 'read_only',
    schema: z.object({}),
    async execute(): Promise<ToolResult> {
      const positions = await provider.getPositions();
      const content = positions.length
        ? positions.map((p) => `${p.symbol}: ${p.quantity} @ ${p.averagePrice}`).join('\n')
        : '(no open positions)';
      return { ok: true, content, data: { positions } };
    },
  });

  const getBalance = defineTool({
    name: 'get_balance',
    description: 'Get the brokerage cash balance. Read-only.',
    kind: 'read_only',
    schema: z.object({}),
    async execute(): Promise<ToolResult> {
      const balance = await provider.getBalance();
      return { ok: true, content: `${balance.cash} ${balance.currency}`, data: { balance } };
    },
  });

  const placeTrade = defineTool({
    name: 'place_trade',
    description:
      'Place a brokerage trade. State-mutating: requires confirmation and is subject to the ' +
      'hard trade notional cap. Provide symbol, side (buy/sell), quantity, and notional (total cash value).',
    kind: 'state_mutating',
    schema: z.object({
      symbol: z.string().describe('Ticker symbol, e.g. AAPL.'),
      side: z.enum(['buy', 'sell']).describe('buy or sell.'),
      quantity: z.number().describe('Number of shares/units (> 0).'),
      notional: z.number().describe('Total cash value of the order (> 0).'),
    }),
    async execute(input): Promise<ToolResult> {
      const { symbol, side, quantity, notional } = input;
      if (!(quantity > 0) || !(notional > 0)) {
        return { ok: false, content: 'quantity and notional must both be positive numbers.' };
      }
      const fill = await provider.placeTrade({ symbol, side, quantity, notional });
      // A submitted order is success unless the broker explicitly rejected it.
      // Real brokers (Alpaca) accept then fill asynchronously ("accepted"/"new"),
      // while the paper broker reports "filled" immediately — both are ok.
      const failed = FAILED_TRADE_STATUSES.has(fill.status.toLowerCase());
      return {
        ok: !failed,
        content: `Trade ${fill.status}: ${fill.side} ${fill.quantity} ${fill.symbol} for ${fill.notional} (order ${fill.orderId}).`,
        data: { fill },
      };
    },
  });

  return [getPositions, getBalance, placeTrade];
}

/** Order statuses that mean the trade did NOT go through. */
const FAILED_TRADE_STATUSES = new Set(['rejected', 'canceled', 'cancelled', 'expired', 'suspended']);

/** Config-shaped selector for the broker behind the trading tools. */
export interface BrokerConfig {
  enabled: boolean;
  broker: 'paper' | 'alpaca';
  startingCash: number;
  alpaca?: { keyId: string; secretKey: string; baseUrl?: string };
}

/**
 * Pick the broker provider from config. Returns undefined when trading is off, so
 * the trading tools simply aren't registered. The paper broker is the default;
 * `alpaca` requires credentials (fails fast if selected without them).
 */
export function buildBrokerProvider(cfg: BrokerConfig): BrokerProvider | undefined {
  if (!cfg.enabled) return undefined;
  if (cfg.broker === 'alpaca') {
    if (!cfg.alpaca) {
      throw new Error('ARES_BROKER=alpaca requires ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY.');
    }
    return new AlpacaBrokerProvider(cfg.alpaca);
  }
  return new PaperBrokerProvider({ startingCash: cfg.startingCash });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
