export type ReactorState = 'idle' | 'thinking' | 'halted' | 'error' | 'offline';

interface ArcReactorProps {
  state: ReactorState;
  size?: 'sm' | 'lg';
}

const sizes = {
  sm: 'h-28 w-28',
  lg: 'h-44 w-44 sm:h-52 sm:w-52',
};

export function ArcReactor({ state, size = 'lg' }: ArcReactorProps) {
  const label = {
    idle: 'ARES core idle',
    thinking: 'ARES core processing',
    halted: 'ARES autonomy halted',
    error: 'ARES core error',
    offline: 'ARES API offline',
  }[state];

  return (
    <div className={`reactor reactor-${state} ${sizes[size]}`} role="img" aria-label={label}>
      <svg viewBox="0 0 240 240" className="h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id={`core-${size}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="white" stopOpacity="0.95" />
            <stop offset="28%" stopColor="var(--reactor-color)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--reactor-color)" stopOpacity="0" />
          </radialGradient>
          <filter id={`glow-${size}`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g fill="none" stroke="var(--reactor-color)">
          <circle cx="120" cy="120" r="108" strokeOpacity="0.18" strokeWidth="1" />
          <circle cx="120" cy="120" r="98" strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="2 8 24 7" className="reactor-ring reactor-outer" />
          <circle cx="120" cy="120" r="84" strokeOpacity="0.25" strokeWidth="8" strokeDasharray="36 12" className="reactor-ring reactor-middle" />
          <circle cx="120" cy="120" r="70" strokeOpacity="0.72" strokeWidth="2" strokeDasharray="4 4 16 8" className="reactor-ring reactor-outer" />
          <circle cx="120" cy="120" r="55" strokeOpacity="0.35" strokeWidth="10" strokeDasharray="2 12" className="reactor-ring reactor-middle" />
          <circle cx="120" cy="120" r="42" strokeOpacity="0.9" strokeWidth="2" filter={`url(#glow-${size})`} />
        </g>

        <g className="reactor-core">
          <circle cx="120" cy="120" r="36" fill={`url(#core-${size})`} opacity="0.88" />
          <circle cx="120" cy="120" r="20" fill="none" stroke="white" strokeOpacity="0.85" strokeWidth="1" />
          <path d="M120 91 145 135 95 135Z" fill="none" stroke="white" strokeOpacity="0.8" strokeWidth="1.5" />
        </g>

        <g fill="var(--reactor-color)" opacity="0.85">
          <rect x="117" y="4" width="6" height="12" />
          <rect x="117" y="224" width="6" height="12" />
          <rect x="4" y="117" width="12" height="6" />
          <rect x="224" y="117" width="12" height="6" />
        </g>
      </svg>
    </div>
  );
}
