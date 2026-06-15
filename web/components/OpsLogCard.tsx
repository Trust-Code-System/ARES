'use client';

import { useState } from 'react';
import type { AuditEvent } from '@/lib/api';

/**
 * One entry in the operations log, rendered as a structured card instead of raw JSON.
 * Each audit event type (tool requested / executed / failed / gate decision / refusal)
 * gets a colour-coded badge, the tool name, a human-readable summary of its `detail`,
 * and a click-to-expand raw payload for when you need the exact bytes.
 */

type Tone = 'cyan' | 'green' | 'red' | 'amber';

const TYPE_META: Record<string, { label: string; tone: Tone }> = {
  tool_requested: { label: 'Call', tone: 'cyan' },
  tool_executed: { label: 'Done', tone: 'green' },
  tool_failed: { label: 'Fail', tone: 'red' },
  tool_gate_decision: { label: 'Gate', tone: 'amber' },
  refusal: { label: 'Refused', tone: 'red' },
};

const TONE_TEXT: Record<Tone, string> = {
  cyan: 'text-ares-cyan',
  green: 'text-ares-green',
  red: 'text-ares-red',
  amber: 'text-ares-amber',
};

const TONE_BORDER: Record<Tone, string> = {
  cyan: 'border-ares-cyan/45',
  green: 'border-ares-green/45',
  red: 'border-ares-red/45',
  amber: 'border-ares-amber/45',
};

function compact(value: unknown, max = 140): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false });
}

/** Key/value lines for an object payload (tool input or result data). */
function KeyValues({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {entries.map(([key, value]) => (
        <div key={key} className="break-words leading-5 text-slate-400">
          <span className="text-ares-muted">{key}:</span> {compact(value)}
        </div>
      ))}
    </div>
  );
}

function Summary({ event }: { event: AuditEvent }) {
  const detail = event.detail;
  switch (event.type) {
    case 'tool_requested': {
      const input = asRecord(detail.input);
      return input ? <KeyValues data={input} /> : <Plain text={compact(detail.input)} />;
    }
    case 'tool_executed': {
      const data = asRecord(detail.data);
      if (data) return <KeyValues data={data} />;
      return <Plain text={detail.data == null ? 'ok' : compact(detail.data)} />;
    }
    case 'tool_failed': {
      const reason = detail.error ?? detail.issues ?? (detail.missing ? `missing: ${compact(detail.missing)}` : null);
      return <Plain text={compact(reason ?? 'failed')} tone="red" />;
    }
    case 'tool_gate_decision':
      return (
        <Plain
          text={detail.approved ? 'approved' : `denied — ${compact(detail.reason)}`}
          tone={detail.approved ? 'green' : 'red'}
        />
      );
    case 'refusal':
      return <Plain text={compact(detail.stopDetails) || 'model declined'} tone="red" />;
    default:
      return <Plain text={compact(detail)} />;
  }
}

function Plain({ text, tone }: { text: string; tone?: Tone }) {
  if (!text) return null;
  return <div className={`mt-1 break-words leading-5 ${tone ? TONE_TEXT[tone] : 'text-slate-400'}`}>{text}</div>;
}

export function OpsLogCard({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TYPE_META[event.type] ?? { label: event.type.toUpperCase(), tone: 'cyan' as Tone };
  const toolName = typeof event.detail.tool === 'string' ? event.detail.tool : null;

  return (
    <li className={`animate-hud-flicker border-l ${TONE_BORDER[meta.tone]} bg-black/25 px-3 py-2`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`shrink-0 font-bold uppercase tracking-[0.12em] ${TONE_TEXT[meta.tone]}`}>{meta.label}</span>
          {toolName && <span className="truncate text-slate-300">{toolName}</span>}
        </div>
        <time className="shrink-0 text-ares-muted">{formatTime(event.ts)}</time>
      </div>
      <Summary event={event} />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:text-ares-cyan"
      >
        {expanded ? 'Hide raw' : 'Raw'}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-ares-line/60 bg-black/40 p-2 text-[10px] leading-4 text-slate-400">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </li>
  );
}
