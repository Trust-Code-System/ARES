import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { AresLogo } from '@/components/AresLogo';
import { AuthGate } from '@/components/AuthGate';
import { HudCorners } from '@/components/HudCorners';
import { PrimaryNav } from '@/components/PrimaryNav';
import { Analytics } from '@vercel/analytics/next';

export const metadata: Metadata = {
  title: 'ARES',
  description: 'Autonomous Reasoning & Execution System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col">
          <header className="relative z-40 flex h-16 shrink-0 items-center justify-between border-b border-ares-line/80 bg-ares-bg/90 px-3 backdrop-blur-xl sm:px-5 md:h-[73px] md:px-6">
            <Link href="/" aria-label="ARES home" className="flex min-w-0 items-center gap-3 outline-none transition hover:opacity-90 focus-visible:opacity-90 sm:gap-4">
              <AresLogo className="h-9 w-9 shrink-0" />
              <div>
                <div className="font-mono text-base font-bold tracking-[0.3em] text-ares-cyan sm:text-lg sm:tracking-[0.34em]">ARES</div>
                <div className="hidden font-mono text-[9px] uppercase tracking-[0.22em] text-ares-muted sm:block">
                  Autonomous Reasoning &amp; Execution System
                </div>
              </div>
            </Link>
            <PrimaryNav />
            <div className="telemetry-line absolute bottom-0 left-0 h-px w-full" />
          </header>
          <main className="relative z-10 min-h-0 flex-1">
            <HudCorners />
            <AuthGate>{children}</AuthGate>
          </main>
        </div>
        <Analytics />
      </body>
    </html>
  );
}
