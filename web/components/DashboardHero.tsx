'use client';

import { useRef, type PointerEvent } from 'react';
import { SystemCore } from '@/components/SystemCore';

interface DashboardHeroProps {
  connected: boolean;
  halted: boolean;
  hasError: boolean;
  toolCount: number;
  model: string;
  pendingCount: number;
  jobCount: number;
  factCount: number;
  unreadCount: number;
}

export function DashboardHero({
  connected,
  halted,
  hasError,
  toolCount,
  model,
  pendingCount,
  jobCount,
  factCount,
  unreadCount,
}: DashboardHeroProps) {
  const sceneRef = useRef<HTMLElement>(null);

  function updatePerspective(event: PointerEvent<HTMLElement>) {
    const scene = sceneRef.current;
    if (!scene) return;
    const bounds = scene.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
    scene.style.setProperty('--hero-near-x', `${x * 22}px`);
    scene.style.setProperty('--hero-near-y', `${y * 16}px`);
    scene.style.setProperty('--hero-far-x', `${x * -10}px`);
    scene.style.setProperty('--hero-far-y', `${y * -8}px`);
    scene.style.setProperty('--hero-tilt-x', `${y * -2.5}deg`);
    scene.style.setProperty('--hero-tilt-y', `${x * 3.5}deg`);
  }

  function resetPerspective() {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.style.setProperty('--hero-near-x', '0px');
    scene.style.setProperty('--hero-near-y', '0px');
    scene.style.setProperty('--hero-far-x', '0px');
    scene.style.setProperty('--hero-far-y', '0px');
    scene.style.setProperty('--hero-tilt-x', '0deg');
    scene.style.setProperty('--hero-tilt-y', '0deg');
  }

  return (
    <section
      ref={sceneRef}
      className="immersive-hero scroll-reveal"
      onPointerMove={updatePerspective}
      onPointerLeave={resetPerspective}
      aria-labelledby="dashboard-hero-title"
    >
      <div className="immersive-hero__stars immersive-hero__far" aria-hidden="true" />
      <div className="immersive-hero__grid immersive-hero__far" aria-hidden="true" />
      <div className="immersive-hero__aurora immersive-hero__near" aria-hidden="true" />
      <div className="immersive-hero__orbit immersive-hero__orbit--one" aria-hidden="true" />
      <div className="immersive-hero__orbit immersive-hero__orbit--two" aria-hidden="true" />

      <div className="immersive-hero__copy">
        <div className="hud-label text-ares-cyan">ARES command intelligence</div>
        <h1 id="dashboard-hero-title" className="mt-3 max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl">
          From intent to <span className="text-ares-cyan">execution.</span>
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-slate-400 sm:text-base">
          One operational view for reasoning, memory, automation, market signals, and principal-controlled action.
        </p>
      </div>

      <div className="immersive-hero__core">
        <div className="immersive-hero__metrics immersive-hero__metrics--left">
          <span>Link</span>
          <strong className={connected ? 'text-ares-green' : 'text-ares-red'}>{connected ? 'Online' : 'Offline'}</strong>
          <span>Pending</span>
          <strong>{pendingCount.toString().padStart(2, '0')}</strong>
          <span>Cycles</span>
          <strong>{jobCount.toString().padStart(2, '0')}</strong>
        </div>

        <div className="immersive-hero__reactor">
          <SystemCore
            compact
            state={!connected ? 'offline' : halted ? 'halted' : hasError ? 'error' : 'idle'}
            connected={connected}
            killEngaged={halted}
            toolCount={toolCount}
            model={model}
          />
        </div>

        <div className="immersive-hero__metrics immersive-hero__metrics--right">
          <span>Memory</span>
          <strong>{factCount.toString().padStart(2, '0')}</strong>
          <span>Tools</span>
          <strong>{toolCount.toString().padStart(2, '0')}</strong>
          <span>Alerts</span>
          <strong className={unreadCount ? 'text-ares-amber' : ''}>{unreadCount.toString().padStart(2, '0')}</strong>
        </div>
      </div>

      <div className="immersive-hero__scroll" aria-hidden="true">
        <span>Scroll to enter operations</span>
        <i />
      </div>
    </section>
  );
}
