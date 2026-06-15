'use client';

import { useEffect, useState } from 'react';

/**
 * System telemetry gauges driven by *real* browser metrics — JS heap usage (Chrome),
 * logical CPU cores, and network reachability — plus a live uplink latency sampled
 * from the caller. Decorative-looking, but the numbers are genuine.
 */

interface PerfMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function HudMetrics({ latencyMs, online }: { latencyMs: number | null; online: boolean }) {
  const [heapPct, setHeapPct] = useState<number | null>(null);
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || null : null;

  useEffect(() => {
    const sample = () => {
      const mem = (performance as Performance & { memory?: PerfMemory }).memory;
      if (mem && mem.jsHeapSizeLimit > 0) {
        setHeapPct(Math.min(100, Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100)));
      }
    };
    sample();
    const id = window.setInterval(sample, 2000);
    return () => window.clearInterval(id);
  }, []);

  // Latency → a 0-100 "signal" gauge (lower latency = fuller bar).
  const signalPct = latencyMs === null ? null : Math.max(4, Math.min(100, Math.round(100 - latencyMs / 6)));

  return (
    <div className="grid grid-cols-3 gap-px border-t border-ares-line bg-ares-line">
      <Gauge label="Heap" value={heapPct} unit="%" tone="cyan" />
      <Gauge label="Uplink" value={signalPct} unit="%" tone={online ? 'green' : 'red'} />
      <Gauge label="Cores" value={cores} max={cores ?? 16} unit="" tone="amber" raw />
    </div>
  );
}

function Gauge({
  label,
  value,
  unit,
  tone,
  max = 100,
  raw = false,
}: {
  label: string;
  value: number | null;
  unit: string;
  tone: 'cyan' | 'amber' | 'green' | 'red';
  max?: number;
  raw?: boolean;
}) {
  const color = { cyan: '#00d9ff', amber: '#ff9f1c', green: '#35f2a1', red: '#ff3b4f' }[tone];
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const r = 18;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-1 bg-ares-bg/90 px-2 py-3">
      <div className="relative h-12 w-12">
        <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90">
          <circle cx="24" cy="24" r={r} fill="none" stroke="#123746" strokeWidth="4" />
          <circle
            cx="24"
            cy="24"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            style={{ filter: `drop-shadow(0 0 4px ${color})`, transition: 'stroke-dasharray 0.6s ease' }}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center font-mono text-[11px] font-bold tabular-nums" style={{ color }}>
          {value === null ? '--' : raw ? value : `${value}`}
        </div>
      </div>
      <span className="hud-label !text-[9px]">{label}{unit && !raw ? ` ${unit}` : ''}</span>
    </div>
  );
}
