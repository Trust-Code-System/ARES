'use client';

import { useEffect, useState, type CSSProperties } from 'react';

interface MissionWidgetsProps {
  connected: boolean;
  toolCount: number;
  totalTools: number;
  factCount: number;
  taskCount: number;
  unreadCount: number;
}

export function MissionWidgets({
  connected,
  toolCount,
  totalTools,
  factCount,
  taskCount,
  unreadCount,
}: MissionWidgetsProps) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const toolReadiness = totalTools ? Math.round((toolCount / totalTools) * 100) : 0;
  const readiness = Math.round(
    (connected ? 35 : 0)
    + Math.min(toolReadiness * 0.35, 35)
    + Math.min(factCount, 20)
    + (unreadCount === 0 ? 10 : 5),
  );

  const clocks = [
    ['Lagos', 'Africa/Lagos'],
    ['UTC', 'UTC'],
    ['New York', 'America/New_York'],
  ] as const;

  return (
    <section className="widget-surface hover-tilt scroll-reveal min-w-0" aria-labelledby="mission-widget-title">
      <header className="border-b border-ares-line/70 px-4 py-4">
        <div className="hud-label">Temporal and system awareness</div>
        <h2 id="mission-widget-title" className="mt-1 font-mono text-sm uppercase tracking-[0.18em] text-ares-amber">
          Mission readiness
        </h2>
      </header>

      <div className="grid gap-5 p-4 sm:grid-cols-[180px_1fr]">
        <div className="readiness-radar" style={{ '--readiness': `${readiness * 3.6}deg` } as CSSProperties}>
          <div>
            <strong>{readiness}%</strong>
            <span>Ready</span>
          </div>
        </div>

        <div className="grid content-center gap-3">
          <div className="grid grid-cols-3 gap-2">
            {clocks.map(([label, timeZone]) => (
              <div key={label} className="border border-ares-line/70 bg-black/20 p-2">
                <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-ares-muted">{label}</div>
                <time className="mt-1 block font-mono text-[11px] tabular-nums text-slate-200">
                  {now ? now.toLocaleTimeString([], { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }) : '--:--'}
                </time>
              </div>
            ))}
          </div>
          <div className="space-y-2 font-mono text-[9px] uppercase tracking-[0.12em]">
            <div className="flex justify-between text-ares-muted"><span>Tool readiness</span><span className="text-ares-cyan">{toolReadiness}%</span></div>
            <div className="readiness-bar"><i style={{ width: `${toolReadiness}%` }} /></div>
            <div className="flex justify-between text-ares-muted"><span>Tracked tasks</span><span className="text-slate-200">{taskCount.toString().padStart(2, '0')}</span></div>
            <div className="flex justify-between text-ares-muted"><span>Unread alerts</span><span className={unreadCount ? 'text-ares-amber' : 'text-ares-green'}>{unreadCount.toString().padStart(2, '0')}</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
