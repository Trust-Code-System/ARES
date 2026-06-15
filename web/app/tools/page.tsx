'use client';

import { useCallback, useEffect, useState } from 'react';
import { HudPanel } from '@/components/HudPanel';
import { Capability, EmptyState } from '@/lib/hud';
import { api, type RuntimeStatus, type ToolInfo } from '@/lib/api';

/**
 * Setup hints for capabilities that are gated behind environment configuration.
 * Surfaced read-only — the UI never stores or sends secrets, it only names the
 * env var the operator must set server-side.
 */
const ENV_HINTS: Array<{ label: string; vars: string; when: (r: RuntimeStatus | null) => boolean }> = [
  { label: 'Persistent memory', vars: 'DATABASE_URL + VOYAGE_API_KEY', when: (r) => !r?.persistentMemory },
  { label: 'Web search', vars: 'TAVILY_API_KEY (or a Gemini key for grounded search)', when: (r) => !r?.webSearchEnabled },
  { label: 'Voice conversation', vars: 'OPENAI_API_KEY / GEMINI_API_KEY + ELEVENLABS_API_KEY', when: (r) => !r?.voiceEnabled },
  { label: 'Python runner', vars: 'ARES_PYTHON_ENABLED=true', when: (r) => !r?.pythonEnabled },
  { label: 'Sandboxed shell', vars: 'ARES_SHELL_ENABLED=true', when: (r) => !r?.shellEnabled },
  { label: 'System actions', vars: 'ARES_SYSTEM_ACTIONS_ENABLED=true', when: (r) => !r?.systemActionsEnabled },
  { label: 'Trading tools', vars: 'ARES_TRADING_ENABLED=true (+ ALPACA_* for live)', when: (r) => !r?.tradingEnabled },
  { label: 'GitHub dev tools', vars: 'GITHUB_TOKEN (+ GITHUB_API_URL for Enterprise)', when: (r) => !r?.githubEnabled },
  { label: 'Connected apps', vars: 'ARES_MCP_SERVERS (Gmail, Calendar, Drive via MCP)', when: (r) => !r?.connectors.length },
];

export default function ToolSettings() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [t, status] = await Promise.all([api.tools(), api.status()]);
      setTools(t.tools);
      setRuntime(status);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function toggle(name: string, enabled: boolean) {
    setMutating(true);
    try {
      await api.toggleTool(name, enabled);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutating(false);
    }
  }

  const enabledCount = tools.filter((tool) => tool.enabled).length;
  const mutatingTools = tools.filter((tool) => tool.kind === 'state_mutating').length;
  const pendingHints = ENV_HINTS.filter((hint) => hint.when(runtime));

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-3 py-4 sm:space-y-5 sm:px-6 sm:py-5 lg:px-8">
      <PageHeader title="Tool settings" subtitle="Enable capabilities, review risk levels, and connector status" />

      {error && (
        <div role="alert" className="border border-ares-red/50 bg-ares-red/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.12em] text-red-200 shadow-hud-red">
          <span className="mr-2 text-ares-red">System alert:</span>
          {error}. Confirm that `npm run serve` is running.
        </div>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-12">
        <HudPanel
          title={`Tool matrix / ${enabledCount} of ${tools.length} active`}
          code={`TLS-${tools.length.toString().padStart(2, '0')}`}
          className="xl:col-span-7"
        >
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ares-muted">
            {mutatingTools} state-mutating (gated) · {tools.length - mutatingTools} read-only
          </p>
          <div className="grid max-h-[34rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {tools.length === 0 && <EmptyState text="No tools registered" />}
            {tools.map((tool) => (
              <label
                key={tool.name}
                className="group flex min-w-0 cursor-pointer items-center gap-2 border border-ares-line bg-black/20 p-3 transition hover:border-ares-cyan/40 hover:bg-ares-cyan/[0.04] sm:gap-3"
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={tool.enabled}
                  disabled={mutating}
                  onChange={() => void toggle(tool.name, !tool.enabled)}
                />
                <span className="grid h-8 w-8 shrink-0 place-items-center border border-ares-line bg-black/40 transition peer-checked:border-ares-cyan peer-checked:bg-ares-cyan/15 peer-checked:shadow-hud-cyan">
                  <span className={`h-2 w-2 transition ${tool.enabled ? 'bg-ares-cyan shadow-[0_0_8px_#00d9ff]' : 'bg-ares-muted'}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-slate-200">{tool.name}</span>
                  <span className="mt-1 block truncate text-[10px] text-ares-muted">{tool.description}</span>
                </span>
                <span className={`shrink-0 font-mono text-[8px] uppercase tracking-wider sm:text-[9px] ${tool.kind === 'state_mutating' ? 'text-ares-amber' : 'text-ares-cyan'}`}>
                  {tool.kind === 'state_mutating' ? 'gated' : 'read'}
                </span>
              </label>
            ))}
          </div>
        </HudPanel>

        <div className="space-y-5 xl:col-span-5">
          <HudPanel title="Capability status" code="CAP-20">
            <div className="grid gap-2 sm:grid-cols-2">
              <Capability name="Reasoning engine" detail={runtime ? `${runtime.provider} / ${runtime.model}` : 'Detecting'} enabled={Boolean(runtime)} />
              <Capability
                name="Voice conversation"
                detail={runtime?.voiceEnabled
                  ? `${runtime.voiceInputProvider ?? 'configured'} input + ${runtime.voiceOutputProvider ?? 'configured'} speech`
                  : 'Configure STT + TTS providers'}
                enabled={Boolean(runtime?.voiceEnabled)}
                warning={!runtime?.voiceEnabled}
              />
              <Capability name="Personal memory" detail={runtime?.persistentMemory ? 'Postgres + semantic retrieval' : 'Ephemeral memory only'} enabled={Boolean(runtime?.persistentMemory)} warning={!runtime?.persistentMemory} />
              <Capability name="Web research" detail="Search + guarded page retrieval" enabled={Boolean(runtime?.webSearchEnabled)} warning={!runtime?.webSearchEnabled} />
              <Capability name="Python execution" detail="Confirmation-gated isolated runner" enabled={Boolean(runtime?.pythonEnabled)} warning={!runtime?.pythonEnabled} />
              <Capability name="System actions" detail="Open approved apps and HTTP(S) sites" enabled={Boolean(runtime?.systemActionsEnabled)} warning={!runtime?.systemActionsEnabled} />
              <Capability name="Trading tools" detail="Read-only by default; trades are gated" enabled={Boolean(runtime?.tradingEnabled)} warning={!runtime?.tradingEnabled} />
              <Capability name="GitHub dev tools" detail="Search + read code; issue creation is gated" enabled={Boolean(runtime?.githubEnabled)} warning={!runtime?.githubEnabled} />
              <Capability name="Connected apps" detail={runtime?.connectors.length ? runtime.connectors.join(', ') : 'No MCP connectors active'} enabled={Boolean(runtime?.connectors.length)} warning={!runtime?.connectors.length} />
            </div>
          </HudPanel>

          <HudPanel title="Setup required" code="ENV-07" accent="amber">
            <p className="mb-3 text-xs leading-5 text-slate-400">
              Set these environment variables server-side, then restart <span className="font-mono text-ares-cyan">npm run serve</span>. Secrets are never entered or stored in this UI.
            </p>
            <div className="space-y-2">
              {pendingHints.length === 0 && <EmptyState text="All capabilities configured" />}
              {pendingHints.map((hint) => (
                <div key={hint.label} className="border-l-2 border-ares-amber/50 bg-black/20 px-3 py-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ares-amber">{hint.label}</div>
                  <div className="mt-1 break-words font-mono text-[10px] text-slate-400">{hint.vars}</div>
                </div>
              ))}
            </div>
          </HudPanel>
        </div>
      </div>
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <h1 className="font-mono text-sm uppercase tracking-[0.22em] text-ares-cyan">{title}</h1>
      <span className="h-px flex-1 bg-gradient-to-r from-ares-cyan/40 to-transparent" />
      <span className="hidden font-mono text-[9px] uppercase tracking-[0.16em] text-ares-muted sm:block">{subtitle}</span>
    </div>
  );
}
