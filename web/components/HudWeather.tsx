'use client';

import { useEffect, useState } from 'react';

/**
 * Live local weather for the HUD, via the keyless Open-Meteo API. Tries the
 * browser's geolocation once, then falls back to a default city (overridable with
 * NEXT_PUBLIC_ARES_WEATHER_LAT/LON) so it always shows something without nagging
 * for permission. Pure client component.
 */

interface Weather {
  tempC: number;
  code: number;
  windKph: number;
  highC: number;
  lowC: number;
  place: string;
}

// Default location used when geolocation is denied/unavailable (Lagos, NG).
const DEFAULT_LAT = Number(process.env.NEXT_PUBLIC_ARES_WEATHER_LAT ?? '6.5244');
const DEFAULT_LON = Number(process.env.NEXT_PUBLIC_ARES_WEATHER_LON ?? '3.3792');

export function HudWeather() {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load(lat: number, lon: number, place: string) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
          + `&current=temperature_2m,weather_code,wind_speed_10m`
          + `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`weather ${res.status}`);
        const json = (await res.json()) as {
          current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
          daily?: { temperature_2m_max: number[]; temperature_2m_min: number[] };
        };
        if (cancelled || !json.current) return;
        setWeather({
          tempC: Math.round(json.current.temperature_2m),
          code: json.current.weather_code,
          windKph: Math.round(json.current.wind_speed_10m),
          highC: Math.round(json.daily?.temperature_2m_max?.[0] ?? json.current.temperature_2m),
          lowC: Math.round(json.daily?.temperature_2m_min?.[0] ?? json.current.temperature_2m),
          place,
        });
      } catch {
        if (!cancelled) setError(true);
      }
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => void load(pos.coords.latitude, pos.coords.longitude, 'Current position'),
        () => void load(DEFAULT_LAT, DEFAULT_LON, 'Default sector'),
        { timeout: 6000, maximumAge: 600000 },
      );
    } else {
      void load(DEFAULT_LAT, DEFAULT_LON, 'Default sector');
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const condition = describeWeather(weather?.code);

  return (
    <div className="relative">
      <div className="flex items-baseline justify-between">
        <span className="hud-label">Atmosphere</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted">
          {weather?.place ?? (error ? 'offline' : 'locating')}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <span className="text-2xl" aria-hidden="true">{condition.icon}</span>
        <span className="font-mono text-3xl font-bold tracking-[0.05em] text-ares-cyan tabular-nums">
          {weather ? `${weather.tempC}°` : '--°'}
        </span>
        <div className="flex flex-col font-mono text-[10px] uppercase tracking-[0.12em] text-ares-muted">
          <span className="text-ares-cyanSoft">{condition.label}</span>
          <span>
            H {weather ? `${weather.highC}°` : '--'} · L {weather ? `${weather.lowC}°` : '--'}
          </span>
          <span>Wind {weather ? `${weather.windKph} km/h` : '--'}</span>
        </div>
      </div>
    </div>
  );
}

/** Map a WMO weather code (Open-Meteo) to a short label + glyph. */
function describeWeather(code: number | undefined): { label: string; icon: string } {
  if (code === undefined) return { label: 'Scanning', icon: '◌' };
  if (code === 0) return { label: 'Clear', icon: '☀️' };
  if (code <= 2) return { label: 'Partly cloudy', icon: '🌤️' };
  if (code === 3) return { label: 'Overcast', icon: '☁️' };
  if (code <= 48) return { label: 'Fog', icon: '🌫️' };
  if (code <= 57) return { label: 'Drizzle', icon: '🌦️' };
  if (code <= 67) return { label: 'Rain', icon: '🌧️' };
  if (code <= 77) return { label: 'Snow', icon: '🌨️' };
  if (code <= 82) return { label: 'Showers', icon: '🌧️' };
  if (code <= 86) return { label: 'Snow showers', icon: '🌨️' };
  return { label: 'Thunderstorm', icon: '⛈️' };
}
