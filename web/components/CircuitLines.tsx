/**
 * Decorative circuit-trace backdrop — the "scientific lines" of the Stark HUD.
 * A static SVG lattice of traces, nodes and a couple of flowing energy pulses that
 * travel along the paths. Purely ornamental: pointer-events off, sits behind
 * content at low opacity.
 */
export function CircuitLines({ className = '' }: { className?: string }) {
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`} aria-hidden="true">
      <svg
        viewBox="0 0 400 600"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full opacity-[0.16]"
        fill="none"
        stroke="var(--hud-cyan)"
      >
        {/* Trace lattice */}
        <g strokeWidth="1" strokeOpacity="0.6">
          <path d="M200 0 V230 M200 370 V600" />
          <path d="M200 230 H120 V300 M200 230 H280 V300" />
          <path d="M200 370 H110 V450 M200 370 H290 V430" />
          <path d="M0 300 H150 M250 300 H400" />
          <path d="M40 120 H160 V200 M360 120 H240 V200" />
          <path d="M40 120 V40 H120 M360 480 V540 H280" />
          <path d="M110 450 V520 H40 M290 430 V500 H360" />
          <path d="M150 300 L185 335 M250 300 L215 335 M150 360 L185 325 M250 360 L215 325" />
        </g>

        {/* Nodes */}
        <g fill="var(--hud-cyan)" stroke="none" fillOpacity="0.7">
          {[
            [200, 230], [200, 370], [120, 300], [280, 300], [110, 450], [290, 430],
            [160, 200], [240, 200], [40, 120], [360, 120], [40, 40], [360, 540],
          ].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.5" />
          ))}
        </g>

        {/* Central processor block */}
        <g strokeWidth="1.2" strokeOpacity="0.85">
          <rect x="178" y="278" width="44" height="44" rx="2" />
          <rect x="186" y="286" width="28" height="28" rx="1" strokeOpacity="0.5" />
          {[182, 188, 194, 200, 206, 212, 218].map((x) => (
            <line key={`t${x}`} x1={x} y1="272" x2={x} y2="278" strokeOpacity="0.5" />
          ))}
          {[182, 188, 194, 200, 206, 212, 218].map((x) => (
            <line key={`b${x}`} x1={x} y1="322" x2={x} y2="328" strokeOpacity="0.5" />
          ))}
        </g>

        {/* Flowing energy pulses along the traces */}
        <g strokeWidth="2.2" strokeLinecap="round" stroke="var(--hud-cyanSoft, #7cecff)">
          <path className="circuit-pulse" d="M200 0 V230 H280 V300" pathLength={100} />
          <path className="circuit-pulse circuit-pulse-delayed" d="M200 600 V370 H110 V450" pathLength={100} />
          <path className="circuit-pulse circuit-pulse-slow" d="M0 300 H150 L185 335" pathLength={100} />
        </g>
      </svg>
    </div>
  );
}
