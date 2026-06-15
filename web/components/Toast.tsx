'use client';

/**
 * Transient HUD notification badge — a small floating confirmation for quick actions
 * (pinning a memory, running a slash command) that don't warrant a full message. The
 * caller owns the lifecycle: render with a {@link ToastMessage} to show it, pass null to
 * hide it, and clear it on a timer.
 */

export interface ToastMessage {
  text: string;
  tone: 'cyan' | 'amber' | 'red';
}

const TONE: Record<ToastMessage['tone'], string> = {
  cyan: 'border-ares-cyan/60 bg-ares-cyan/10 text-ares-cyan shadow-[0_0_24px_rgba(0,217,255,0.3)]',
  amber: 'border-ares-amber/60 bg-ares-amber/10 text-ares-amber shadow-[0_0_24px_rgba(255,159,28,0.3)]',
  red: 'border-ares-red/60 bg-ares-red/10 text-ares-red shadow-[0_0_24px_rgba(255,59,79,0.3)]',
};

export function Toast({ toast }: { toast: ToastMessage | null }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2">
      <div
        className={`flex items-center gap-2 border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] backdrop-blur ${TONE[toast.tone]}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        {toast.text}
      </div>
    </div>
  );
}
