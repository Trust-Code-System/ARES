'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const LINKS = [
  { href: '/', label: 'Interface', accent: 'cyan' },
  { href: '/dashboard', label: 'Dashboard', accent: 'amber' },
  { href: '/memory', label: 'Memory', accent: 'cyan' },
  { href: '/activity', label: 'Activity', accent: 'cyan' },
  { href: '/tools', label: 'Tools', accent: 'cyan' },
] as const;

export function PrimaryNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <nav aria-label="Primary navigation" className="hidden items-center gap-1 font-mono text-xs uppercase tracking-[0.16em] md:flex">
        {LINKS.map((link) => (
          <NavLink key={link.href} {...link} active={pathname === link.href} />
        ))}
      </nav>

      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-navigation"
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        onClick={() => setOpen((value) => !value)}
        className="grid h-11 w-11 place-items-center border border-ares-line bg-black/30 text-ares-cyan transition hover:border-ares-cyan/50 md:hidden"
      >
        <span className="relative block h-4 w-5" aria-hidden="true">
          <span className={`absolute left-0 top-0 h-px w-5 bg-current transition ${open ? 'translate-y-[7px] rotate-45' : ''}`} />
          <span className={`absolute left-0 top-[7px] h-px w-5 bg-current transition ${open ? 'opacity-0' : ''}`} />
          <span className={`absolute left-0 top-[14px] h-px w-5 bg-current transition ${open ? '-translate-y-[7px] -rotate-45' : ''}`} />
        </span>
      </button>

      {open && (
        <nav
          id="mobile-navigation"
          aria-label="Mobile navigation"
          className="absolute inset-x-0 top-full z-50 grid grid-cols-2 gap-px border-b border-ares-cyan/35 bg-ares-line p-px shadow-hud-cyan md:hidden"
        >
          {LINKS.map((link) => (
            <NavLink key={link.href} {...link} active={pathname === link.href} mobile />
          ))}
        </nav>
      )}
    </>
  );
}

function NavLink({
  href,
  label,
  accent,
  active,
  mobile = false,
}: {
  href: string;
  label: string;
  accent: 'cyan' | 'amber';
  active: boolean;
  mobile?: boolean;
}) {
  const tone = accent === 'amber'
    ? 'hover:border-ares-amber/30 hover:text-ares-amber'
    : 'hover:border-ares-cyan/30 hover:text-ares-cyan';
  const selected = active
    ? accent === 'amber'
      ? 'border-ares-amber/40 bg-ares-amber/10 text-ares-amber'
      : 'border-ares-cyan/40 bg-ares-cyan/10 text-ares-cyan'
    : `border-transparent text-ares-muted ${tone}`;

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`border font-mono uppercase transition ${selected} ${
        mobile
          ? 'min-h-12 bg-ares-bg/95 px-4 py-3 text-center text-[11px] tracking-[0.16em]'
          : 'px-3 py-2 text-xs tracking-[0.16em]'
      }`}
    >
      {label}
    </Link>
  );
}
