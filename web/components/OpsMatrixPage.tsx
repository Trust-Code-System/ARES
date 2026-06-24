'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { HudPanel } from '@/components/HudPanel';
import { EmptyState } from '@/lib/hud';
import { api, type McpServerInfo, type SkillImportResult, type SkillInfo, type ToolInfo } from '@/lib/api';

type PageKind =
  | 'skills'
  | 'skill-import'
  | 'skill-audit'
  | 'enabled-skills'
  | 'mcp-servers'
  | 'agents'
  | 'memory-manager'
  | 'tool-permissions'
  | 'confirmation-queue'
  | 'execution-logs'
  | 'project-context';

const TITLES: Record<PageKind, string> = {
  skills: 'Skills Library',
  'skill-import': 'Skill Import',
  'skill-audit': 'Skill Audit Report',
  'enabled-skills': 'Enabled Skills',
  'mcp-servers': 'MCP Servers',
  agents: 'Agent Personas',
  'memory-manager': 'Memory Manager',
  'tool-permissions': 'Tool Permissions',
  'confirmation-queue': 'Confirmation Queue',
  'execution-logs': 'Execution Logs',
  'project-context': 'Project Context',
};

export function OpsMatrixPage({ kind }: { kind: PageKind }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [audit, setAudit] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    const result = await api.skills().catch(() => ({ skills: [] }));
    setSkills(result.skills);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const [skillResult, toolResult] = await Promise.all([api.skills().catch(() => ({ skills: [] })), api.tools().catch(() => ({ tools: [] }))]);
        setSkills(skillResult.skills);
        setTools(toolResult.tools);
        if (kind === 'skill-audit') setAudit((await api.auditSkills()).report);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
    void load();
  }, [kind]);

  const visibleSkills = useMemo(() => {
    if (kind === 'enabled-skills') return skills;
    return skills;
  }, [kind, skills]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-sm uppercase tracking-[0.22em] text-ares-cyan">{TITLES[kind]}</h1>
        <span className="h-px flex-1 bg-gradient-to-r from-ares-cyan/40 to-transparent" />
      </div>

      {error && <div className="border border-ares-red/50 bg-ares-red/10 px-4 py-3 text-xs text-red-200">{error}</div>}

      {kind === 'skill-import' && <SkillImportPanel onImported={loadSkills} />}

      {kind === 'mcp-servers' && <McpManagerPanel />}

      {kind === 'skill-audit' && (
        <HudPanel title="Latest scan" code="AUDIT">
          <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-slate-300">{audit || 'No audit report loaded.'}</pre>
        </HudPanel>
      )}

      {kind === 'tool-permissions' && (
        <HudPanel title="Tool permissions" code="TOOLS">
          <div className="grid gap-2 md:grid-cols-2">
            {tools.map((tool) => (
              <div key={tool.name} className="border border-ares-line bg-black/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-xs text-slate-100">{tool.name}</span>
                  <span className={tool.kind === 'state_mutating' ? 'text-ares-amber' : 'text-ares-cyan'}>{tool.kind}</span>
                </div>
                <p className="mt-2 text-xs text-ares-muted">{tool.description}</p>
              </div>
            ))}
          </div>
        </HudPanel>
      )}

      {(kind === 'skills' || kind === 'enabled-skills' || kind === 'skill-import') && (
        <HudPanel title={`${visibleSkills.length} skills`} code="SKILLS">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {visibleSkills.length === 0 && <EmptyState text="No skills returned by API" />}
            {visibleSkills.map((skill) => (
              <article key={skill.id} className="border border-ares-line bg-black/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-mono text-xs text-slate-100">{skill.name}</h2>
                    <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-ares-muted">{skill.category}</p>
                  </div>
                  <span className={riskClass(skill.riskLevel)}>{skill.riskLevel}</span>
                </div>
                <p className="mt-3 line-clamp-3 text-xs leading-5 text-slate-400">{skill.description}</p>
                <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px] text-ares-muted">
                  <span>{skill.scripts} scripts</span>
                  <span>{skill.version ?? 'unversioned'}</span>
                </div>
              </article>
            ))}
          </div>
        </HudPanel>
      )}

      {(kind === 'agents' || kind === 'memory-manager' || kind === 'confirmation-queue' || kind === 'execution-logs' || kind === 'project-context') && (
        <HudPanel title="Operational surface" code="OPS">
          <p className="text-sm leading-6 text-slate-300">
            This page is wired into the ARES control plane. Use the API routes for live data while the specialized backend store is expanded.
          </p>
        </HudPanel>
      )}
    </div>
  );
}

function SkillImportPanel({ onImported }: { onImported: () => void | Promise<void> }) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SkillImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.importSkill({ url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) });
      setResult(res.installed);
      setUrl('');
      setRef('');
      await onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HudPanel title="Install from GitHub" code="IMPORT">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs leading-5 text-ares-muted">
          Paste a GitHub repository URL containing SKILL.md playbooks (ARES / Codex / Claude format). ARES clones files only — it never
          executes repository code — runs the static security scanner, then makes the skills available to find_skill / use_skill.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/skill-pack"
            className="flex-1 border border-ares-line bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-ares-muted/60 focus:border-ares-cyan/50"
          />
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="ref (optional)"
            className="w-full border border-ares-line bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-ares-muted/60 focus:border-ares-cyan/50 sm:w-40"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="border border-ares-cyan/40 bg-ares-cyan/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.16em] text-ares-cyan transition hover:bg-ares-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </form>

      {error && <div className="mt-3 border border-ares-red/50 bg-ares-red/10 px-4 py-3 text-xs text-red-200">{error}</div>}

      {result && (
        <div className="mt-3 border border-ares-cyan/30 bg-ares-cyan/5 p-3">
          <p className="font-mono text-xs text-slate-100">
            Installed {result.skillsInstalled} skill(s) from {result.owner}/{result.repo}
            {result.ref ? `@${result.ref}` : ''}
          </p>
          <p className="mt-1 font-mono text-[10px] text-ares-muted">
            Worst scanner finding: {result.worstFinding ?? 'none'}
          </p>
          {result.scanReport && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-slate-400">{result.scanReport}</pre>
          )}
        </div>
      )}
    </HudPanel>
  );
}

function McpManagerPanel() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Install form
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'npm' | 'command'>('npm');
  const [npmPackage, setNpmPackage] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [enableNow, setEnableNow] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await api.mcpServers();
      setServers(res.servers);
      setNote(res.note ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function install(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    if (mode === 'npm' ? !npmPackage.trim() : !command.trim()) return;
    setBusy(true);
    setError(null);
    const args = argsText.split(/\s+/).filter(Boolean);
    try {
      await api.installMcp({
        name: name.trim(),
        enabled: enableNow,
        ...(mode === 'npm'
          ? { npmPackage: npmPackage.trim(), ...(args.length ? { packageArgs: args } : {}) }
          : { command: command.trim(), ...(args.length ? { args } : {}) }),
      });
      setName('');
      setNpmPackage('');
      setCommand('');
      setArgsText('');
      setEnableNow(false);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(server: McpServerInfo) {
    setBusy(true);
    try {
      await api.setMcpEnabled(server.name, !server.enabled);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(server: McpServerInfo) {
    setBusy(true);
    try {
      await api.removeMcp(server.name);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <HudPanel title="Install MCP server" code="MCP">
        <form onSubmit={install} className="space-y-3">
          <p className="text-xs leading-5 text-ares-muted">
            Register a stdio MCP server (the same connectors Claude and Codex use). ARES writes the managed config now; tools from enabled
            servers are imported on the next ARES restart. Installed disabled by default — enable after review.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (e.g. filesystem)"
              className="w-full border border-ares-line bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-ares-muted/60 focus:border-ares-cyan/50 sm:w-48"
            />
            <div className="flex border border-ares-line">
              {(['npm', 'command'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition ${
                    mode === m ? 'bg-ares-cyan/15 text-ares-cyan' : 'text-ares-muted hover:text-ares-cyan'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          {mode === 'npm' ? (
            <input
              value={npmPackage}
              onChange={(e) => setNpmPackage(e.target.value)}
              placeholder="@modelcontextprotocol/server-filesystem"
              className="w-full border border-ares-line bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-ares-muted/60 focus:border-ares-cyan/50"
            />
          ) : (
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="custom stdio command, e.g. python"
              className="w-full border border-ares-line bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-ares-muted/60 focus:border-ares-cyan/50"
            />
          )}
          <input
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder={mode === 'npm' ? 'extra args after the package (space-separated)' : 'command args (space-separated)'}
            className="w-full border border-ares-line bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-ares-muted/60 focus:border-ares-cyan/50"
          />
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 font-mono text-[11px] text-ares-muted">
              <input type="checkbox" checked={enableNow} onChange={(e) => setEnableNow(e.target.checked)} className="accent-ares-cyan" />
              enable on next restart
            </label>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="border border-ares-cyan/40 bg-ares-cyan/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.16em] text-ares-cyan transition hover:bg-ares-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Install'}
            </button>
          </div>
        </form>
        {error && <div className="mt-3 border border-ares-red/50 bg-ares-red/10 px-4 py-3 text-xs text-red-200">{error}</div>}
      </HudPanel>

      <HudPanel title={`${servers.length} installed`} code="SERVERS">
        {note && <p className="mb-3 text-xs text-ares-amber">{note}</p>}
        {servers.length === 0 && !note && <EmptyState text="No MCP servers installed yet" />}
        <div className="grid gap-2">
          {servers.map((server) => (
            <div key={server.name} className="border border-ares-line bg-black/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs text-slate-100">{server.name}</span>
                    <span className={server.enabled ? 'font-mono text-[10px] uppercase text-ares-cyan' : 'font-mono text-[10px] uppercase text-ares-muted'}>
                      {server.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-ares-muted">
                    {server.command} {server.args.join(' ')}
                  </p>
                  {server.source && <p className="truncate font-mono text-[10px] text-ares-muted/70">{server.source}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => toggle(server)}
                    disabled={busy}
                    className="border border-ares-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ares-muted transition hover:border-ares-cyan/40 hover:text-ares-cyan disabled:opacity-40"
                  >
                    {server.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(server)}
                    disabled={busy}
                    className="border border-ares-red/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ares-red/80 transition hover:bg-ares-red/10 disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </HudPanel>
    </>
  );
}

function riskClass(risk: SkillInfo['riskLevel']): string {
  if (risk === 'high') return 'font-mono text-[10px] uppercase tracking-[0.12em] text-ares-red';
  if (risk === 'medium') return 'font-mono text-[10px] uppercase tracking-[0.12em] text-ares-amber';
  return 'font-mono text-[10px] uppercase tracking-[0.12em] text-ares-cyan';
}
