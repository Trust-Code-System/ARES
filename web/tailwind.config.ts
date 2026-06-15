import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ares: {
          bg: '#02060a',
          panel: '#07131c',
          panelBright: '#0a1e2a',
          cyan: '#00d9ff',
          cyanSoft: '#7cecff',
          amber: '#ff9f1c',
          red: '#ff3b4f',
          green: '#35f2a1',
          muted: '#7394a3',
          line: '#123746',
        },
      },
      boxShadow: {
        'hud-cyan': '0 0 24px rgba(0, 217, 255, 0.18), inset 0 0 20px rgba(0, 217, 255, 0.04)',
        'hud-amber': '0 0 22px rgba(255, 159, 28, 0.18)',
        'hud-red': '0 0 24px rgba(255, 59, 79, 0.25)',
      },
      keyframes: {
        'hud-spin': { to: { transform: 'rotate(360deg)' } },
        'hud-spin-reverse': { to: { transform: 'rotate(-360deg)' } },
        'hud-pulse': {
          '0%, 100%': { opacity: '0.72', transform: 'scale(0.96)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
        'hud-flicker': {
          '0%, 100%': { opacity: '1' },
          '42%': { opacity: '0.72' },
          '44%': { opacity: '1' },
          '78%': { opacity: '0.86' },
        },
        'hud-shimmer': {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'hud-grid': {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(48px)' },
        },
      },
      animation: {
        'hud-spin': 'hud-spin 18s linear infinite',
        'hud-spin-fast': 'hud-spin 4s linear infinite',
        'hud-spin-reverse': 'hud-spin-reverse 12s linear infinite',
        'hud-pulse': 'hud-pulse 2.8s ease-in-out infinite',
        'hud-pulse-fast': 'hud-pulse 0.9s ease-in-out infinite',
        'hud-flicker': 'hud-flicker 4s steps(1) infinite',
        'hud-shimmer': 'hud-shimmer 2.2s linear infinite',
        'hud-grid': 'hud-grid 12s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
