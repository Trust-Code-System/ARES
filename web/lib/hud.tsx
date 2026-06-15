/**
 * Shared HUD presentational helpers, extracted so every page reuses them instead
 * of copy-pasting. Pure, stateless components + formatters — no data fetching.
 */

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="border border-dashed border-ares-line px-4 py-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ares-muted">
      {text}
    </div>
  );
}

export function MetricStack({
  items,
  align = 'left',
}: {
  items: Array<[string, string]>;
  align?: 'left' | 'right';
}) {
  return (
    <div className={`space-y-4 ${align === 'right' ? 'text-right' : ''}`}>
      {items.map(([label, value]) => (
        <div
          key={label}
          className={align === 'right' ? 'border-r border-ares-cyan/35 pr-3' : 'border-l border-ares-cyan/35 pl-3'}
        >
          <div className="hud-label">{label}</div>
          <div className="hud-value mt-1">{value}</div>
        </div>
      ))}
    </div>
  );
}

export function Capability({
  name,
  detail,
  enabled,
  warning = false,
}: {
  name: string;
  detail: string;
  enabled: boolean;
  warning?: boolean;
}) {
  const color = enabled
    ? 'border-ares-cyan/40 text-ares-cyan'
    : warning
      ? 'border-ares-amber/40 text-ares-amber'
      : 'border-ares-line text-ares-muted';
  return (
    <div className={`min-w-0 border bg-black/20 p-3 ${color}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em]">{name}</span>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            enabled ? 'bg-ares-cyan shadow-[0_0_8px_#00d9ff]' : warning ? 'bg-ares-amber' : 'bg-ares-muted'
          }`}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-400">{detail}</p>
      <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em]">
        {enabled ? 'Operational' : 'Setup required'}
      </div>
    </div>
  );
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false });
}

/** Colour for an autonomous-activity / run lifecycle status. */
export function statusColor(status: string): string {
  if (status === 'failed' || status === 'aborted' || status === 'error') return 'text-ares-red';
  if (status === 'skipped') return 'text-ares-amber';
  if (status === 'completed') return 'text-ares-green';
  return 'text-ares-cyan';
}

export function taskStatusColor(status: string): string {
  if (status === 'done') return 'border-ares-green/50 text-ares-green';
  if (status === 'in_progress') return 'border-ares-cyan/50 text-ares-cyan';
  if (status === 'cancelled') return 'border-ares-line text-ares-muted';
  return 'border-ares-amber/50 text-ares-amber';
}

export function urgencyColor(urgency: string): string {
  if (urgency === 'high') return 'text-ares-red';
  if (urgency === 'low') return 'text-ares-muted';
  return 'text-ares-cyan';
}
