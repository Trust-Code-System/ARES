'use client';

import { useCallback, useEffect, useState } from 'react';

interface MarketAsset {
  id: string;
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  marketCap: number;
  sparkline: number[];
}

interface MarketResponse {
  assets: MarketAsset[];
  updatedAt: string;
  source: string;
}

export function MarketWidget() {
  const [data, setData] = useState<MarketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/market', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Market feed unavailable (${response.status})`);
      setData(await response.json() as MarketResponse);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  return (
    <section className="widget-surface hover-tilt scroll-reveal min-w-0" aria-labelledby="market-widget-title">
      <header className="flex items-start justify-between gap-4 border-b border-ares-line/70 px-4 py-4">
        <div>
          <div className="hud-label">External intelligence / live</div>
          <h2 id="market-widget-title" className="mt-1 font-mono text-sm uppercase tracking-[0.18em] text-ares-cyan">
            Crypto market pulse
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="border border-ares-line px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:border-ares-cyan/60 hover:text-ares-cyan"
          disabled={loading}
        >
          {loading ? 'Syncing' : 'Refresh'}
        </button>
      </header>

      <div className="grid gap-px bg-ares-line/60 sm:grid-cols-3" aria-live="polite">
        {data?.assets.map((asset) => {
          const positive = asset.change24h >= 0;
          return (
            <article key={asset.id} className="market-asset bg-ares-bg/95 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ares-muted">{asset.name}</div>
                  <div className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-slate-200">{asset.symbol}</div>
                </div>
                <span className={`font-mono text-[10px] ${positive ? 'text-ares-green' : 'text-ares-red'}`}>
                  {positive ? '+' : ''}{asset.change24h.toFixed(2)}%
                </span>
              </div>
              <div className="mt-4 text-xl font-semibold tabular-nums text-white">
                {formatUsd(asset.price)}
              </div>
              <svg className={`mt-3 h-12 w-full ${positive ? 'text-ares-green' : 'text-ares-red'}`} viewBox="0 0 180 48" role="img" aria-label={`${asset.name} seven day price trend`}>
                <path d={sparklinePath(asset.sparkline, 180, 48)} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="mt-2 flex justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-ares-muted">
                <span>Market cap</span>
                <span>{formatCompactUsd(asset.marketCap)}</span>
              </div>
            </article>
          );
        })}

        {loading && !data && (
          <div className="col-span-full bg-ares-bg/95 px-4 py-12 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-ares-cyan">
            Acquiring market telemetry...
          </div>
        )}

        {error && !data && (
          <div className="col-span-full bg-ares-bg/95 px-4 py-10 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ares-red">Feed interrupted</div>
            <p className="mt-2 text-xs text-slate-500">{error}</p>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 px-4 py-3 font-mono text-[9px] uppercase tracking-[0.12em] text-ares-muted">
        <span>{data?.source ?? 'CoinGecko market data'}</span>
        <time>{data ? `Updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '--:--'}</time>
      </footer>
    </section>
  );
}

function sparklinePath(values: number[], width: number, height: number): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return `M0 ${height / 2} L${width} ${height / 2}`;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const spread = max - min || 1;
  return finite
    .map((value, index) => {
      const x = (index / (finite.length - 1)) * width;
      const y = height - ((value - min) / spread) * (height - 4) - 2;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatCompactUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}
