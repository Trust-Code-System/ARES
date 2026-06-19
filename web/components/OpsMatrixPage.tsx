'use client';

import { useEffect, useMemo, useState } from 'react';
import { HudPanel } from '@/components/HudPanel';
import { EmptyState } from '@/lib/hud';
import { api, type SkillInfo, type ToolInfo } from '@/lib/api';

type PageKind =
  | 'skills'
  | 'skill-import'
  | 'skill-audit'
  | 'enabled-skills'
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

function riskClass(risk: SkillInfo['riskLevel']): string {
  if (risk === 'high') return 'font-mono text-[10px] uppercase tracking-[0.12em] text-ares-red';
  if (risk === 'medium') return 'font-mono text-[10px] uppercase tracking-[0.12em] text-ares-amber';
  return 'font-mono text-[10px] uppercase tracking-[0.12em] text-ares-cyan';
}
