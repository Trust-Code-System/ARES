/**
 * ARES brand mark: the arc-reactor triangle inside a slowly rotating ring — the
 * compact form of the HUD centerpiece. Pure SVG/CSS, themes with the cyan token,
 * scales crisply. Size it via `className` (e.g. `h-9 w-9`).
 */
export function AresLogo({ className = '' }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="ARES"
      className={`relative grid place-items-center rounded-full border border-ares-cyan/60 text-ares-cyan shadow-hud-cyan ${className}`}
    >
      {/* Rotating dashed ring — keeps the "live HUD" feel. */}
      <span className="absolute inset-1 animate-hud-spin rounded-full border border-dashed border-ares-cyan/40" />
      {/* Reactor triangle + glowing core. */}
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-[58%] w-[58%]">
        <path d="M12 4 L19.5 17.5 H4.5 Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="13.5" r="2" fill="currentColor" className="drop-shadow-[0_0_6px_#00d9ff]" />
      </svg>
    </span>
  );
}
