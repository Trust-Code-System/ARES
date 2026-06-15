import type { ReactNode } from 'react';

interface HudPanelProps {
  title: string;
  code?: string;
  accent?: 'cyan' | 'amber' | 'red';
  children: ReactNode;
  className?: string;
}

const accentClasses = {
  cyan: 'text-ares-cyan border-ares-cyan/50',
  amber: 'text-ares-amber border-ares-amber/50',
  red: 'text-ares-red border-ares-red/50',
};

export function HudPanel({ title, code = 'SYS', accent = 'cyan', children, className = '' }: HudPanelProps) {
  return (
    <section className={`hud-panel min-w-0 ${className}`}>
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-ares-line/70 px-3 py-3 sm:px-4">
        <h2 className={`min-w-0 border-l-2 pl-3 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] sm:text-xs sm:tracking-[0.2em] ${accentClasses[accent]}`}>
          {title}
        </h2>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-ares-muted">{code}</span>
      </header>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}
