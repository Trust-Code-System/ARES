'use client';

import { useEffect, useState, type MutableRefObject } from 'react';

/**
 * Compact, HUD-styled microphone input meter for the command toolbar. A segmented bar
 * lights up with the live mic amplitude (cyan → amber → red as it climbs) so the user
 * can confirm at a glance that their voice is actually reaching the mic — the missing
 * feedback loop for far-field wake-word listening, which otherwise fails silently.
 *
 * Presentational only: the mic stream is owned by {@link useMicAudio} up in the page, and
 * the live amplitude arrives via {@link MicLevelProps.levelRef}. To keep the page from
 * re-rendering on every audio frame, this component samples that ref on its own throttled
 * animation loop and holds the displayed value in local state — so updates stay confined
 * to this subtree. Renders nothing meaningful until a stream is active.
 */

export interface MicLevelProps {
  /** Live smoothed level 0..1, written each audio frame by {@link useMicAudio}. */
  levelRef: MutableRefObject<number>;
  /** Whether the mic stream is open and metering. */
  active: boolean;
  /** Permission/device error, if any. */
  error: string | null;
}

const SEGMENTS = 14;
const CYAN = '#00d9ff';
const AMBER = '#ff9f1c';
const RED = '#ff3b4f';
/** Min ms between displayed updates — ~25 fps, easy on React. */
const UPDATE_MS = 40;

function segmentColor(index: number): string {
  const frac = index / (SEGMENTS - 1);
  if (frac >= 0.85) return RED;
  if (frac >= 0.6) return AMBER;
  return CYAN;
}

export function MicLevel({ levelRef, active, error }: MicLevelProps) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= UPDATE_MS) {
        last = now;
        setLevel(levelRef.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  const lit = Math.round(level * SEGMENTS);

  return (
    <span
      className="flex h-9 shrink-0 items-center gap-2 border border-ares-line bg-ares-bg px-2"
      title={error ? `Microphone: ${error}` : 'Live microphone input level'}
    >
      <span className="hud-label !text-[9px]">Mic</span>
      {error ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ares-red">{error}</span>
      ) : (
        <span className="flex items-end gap-[2px]" aria-hidden>
          {Array.from({ length: SEGMENTS }, (_, index) => {
            const on = active && index < lit;
            const color = segmentColor(index);
            // Slight rising height gives the bar an equaliser silhouette.
            const height = 6 + (index / (SEGMENTS - 1)) * 8;
            return (
              <span
                key={index}
                className="w-[3px] rounded-[1px] transition-[opacity,background-color] duration-75"
                style={{
                  height,
                  backgroundColor: on ? color : '#0f2a36',
                  opacity: on ? 1 : 0.5,
                  boxShadow: on ? `0 0 5px ${color}` : 'none',
                }}
              />
            );
          })}
        </span>
      )}
    </span>
  );
}
