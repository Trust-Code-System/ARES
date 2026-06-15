import { ArcReactor, type ReactorState } from '@/components/ArcReactor';

interface SystemCoreProps {
  state: ReactorState;
  connected: boolean;
  killEngaged: boolean;
  toolCount: number;
  model?: string;
  compact?: boolean;
}

export function SystemCore({
  state,
  connected,
  killEngaged,
  toolCount,
  model = process.env.NEXT_PUBLIC_ARES_MODEL ?? 'claude-opus-4-8',
  compact = false,
}: SystemCoreProps) {
  const status = state === 'thinking' ? 'processing' : state === 'halted' ? 'halted' : state;

  return (
    <section className={`relative mx-auto flex w-full max-w-3xl items-center justify-center ${compact ? 'min-h-36' : 'min-h-56 sm:min-h-64'}`}>
      <div className="absolute left-1/2 top-1/2 h-px w-[min(92vw,660px)] -translate-x-1/2 bg-gradient-to-r from-transparent via-ares-cyan/25 to-transparent" />
      <div className="absolute left-1/2 top-1/2 h-[min(42vw,250px)] w-px -translate-x-1/2 -translate-y-1/2 bg-gradient-to-b from-transparent via-ares-cyan/20 to-transparent" />
      <ArcReactor state={state} size={compact ? 'sm' : 'lg'} />

      <div className="absolute left-0 top-1/2 hidden -translate-y-1/2 border-l border-ares-cyan/40 pl-3 sm:block">
        <div className="hud-label">Network</div>
        <div className={connected ? 'hud-value text-ares-green' : 'hud-value text-ares-red'}>
          {connected ? 'linked' : 'offline'}
        </div>
        <div className="mt-3 hud-label">Model</div>
        <div className="hud-value max-w-40 truncate">{model}</div>
      </div>

      <div className="absolute right-0 top-1/2 hidden -translate-y-1/2 border-r border-ares-amber/40 pr-3 text-right sm:block">
        <div className="hud-label">Autonomy</div>
        <div className={killEngaged ? 'hud-value text-ares-red' : 'hud-value text-ares-green'}>
          {killEngaged ? 'halted' : 'enabled'}
        </div>
        <div className="mt-3 hud-label">Tools online</div>
        <div className="hud-value text-ares-amber">{toolCount.toString().padStart(2, '0')}</div>
      </div>

      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap text-center">
        <div className="hud-label">Core state</div>
        <div className={state === 'thinking' ? 'hud-value thinking-shimmer' : 'hud-value'}>{status}</div>
      </div>
    </section>
  );
}
