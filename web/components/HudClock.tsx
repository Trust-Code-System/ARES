'use client';

import { useEffect, useState } from 'react';

/**
 * Live mission clock — big 24h time, day of week, and date, in the Stark HUD style.
 * Renders nothing until mounted so the server/client first paint can't disagree on
 * the current second (hydration safety).
 */
export function HudClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const time = now ? now.toLocaleTimeString([], { hour12: false }) : '--:--:--';
  const weekday = now ? now.toLocaleDateString([], { weekday: 'long' }) : '—';
  const date = now ? now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const tz = now ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';

  return (
    <div className="relative">
      <div className="flex items-baseline justify-between">
        <span className="hud-label">Local time</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted">{tz}</span>
      </div>
      <div className="mt-1 font-mono text-3xl font-bold tracking-[0.16em] text-ares-cyan tabular-nums [text-shadow:0_0_14px_rgba(0,217,255,0.45)]">
        {time}
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]">
        <span className="text-ares-amber">{weekday}</span>
        <span className="h-px flex-1 bg-gradient-to-r from-ares-amber/40 to-transparent" />
        <span className="text-ares-muted">{date}</span>
      </div>
    </div>
  );
}
