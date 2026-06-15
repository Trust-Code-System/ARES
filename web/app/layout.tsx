import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { AuthGate } from '@/components/AuthGate';

export const metadata: Metadata = {
  title: 'ARES',
  description: 'Autonomous Reasoning & Execution System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col">
          <header className="relative z-40 flex h-[73px] items-center justify-between border-b border-ares-line/80 bg-ares-bg/85 px-4 backdrop-blur-xl sm:px-6">
            <div className="flex items-center gap-4">
              <div className="relative grid h-9 w-9 place-items-center rounded-full border border-ares-cyan/60 shadow-hud-cyan">
                <span className="h-2 w-2 rounded-full bg-ares-cyan shadow-[0_0_12px_#00d9ff]" />
                <span className="absolute inset-1 animate-hud-spin rounded-full border border-dashed border-ares-cyan/40" />
              </div>
              <div>
                <div className="font-mono text-lg font-bold tracking-[0.34em] text-ares-cyan">ARES</div>
                <div className="hidden font-mono text-[9px] uppercase tracking-[0.22em] text-ares-muted sm:block">
                  Autonomous Reasoning &amp; Execution System
                </div>
              </div>
            </div>
            <nav aria-label="Primary navigation" className="flex items-center gap-1 font-mono text-xs uppercase tracking-[0.16em]">
              <Link href="/" className="border border-transparent px-3 py-2 text-ares-muted transition hover:border-ares-cyan/30 hover:text-ares-cyan">
                Interface
              </Link>
              <Link href="/dashboard" className="border border-transparent px-3 py-2 text-ares-muted transition hover:border-ares-amber/30 hover:text-ares-amber">
                Systems
              </Link>
            </nav>
            <div className="telemetry-line absolute bottom-0 left-0 h-px w-full" />
          </header>
          <main className="relative z-10 flex-1">
            <AuthGate>{children}</AuthGate>
          </main>
        </div>
      </body>
    </html>
  );
}
