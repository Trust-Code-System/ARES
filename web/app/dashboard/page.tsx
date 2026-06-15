'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { HudPanel } from '@/components/HudPanel';
import { SystemCore } from '@/components/SystemCore';
import { Capability, EmptyState, MetricStack, taskStatusColor } from '@/lib/hud';
import {
  api,
  type Confirmation,
  type Job,
  type KillSwitchState,
  type RuntimeStatus,
  type Task,
  type TaskStatus,
  type ToolInfo,
} from '@/lib/api';

export default function Dashboard() {
  const [kill, setKill] = useState<KillSwitchState | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [factCount, setFactCount] = useState(0);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [health, status, k, c, t, j, m, ts, n] = await Promise.all([
        api.health(),
        api.status(),
        api.killSwitch(),
        api.confirmations(),
        api.tools(),
        api.jobs(),
        api.memory(),
        api.tasks(),
        api.notifications(),
      ]);
      setConnected(health.ok);
      setRuntime(status);
      setKill(k.state);
      setConfirmations(c.pending);
      setTools(t.tools);
      setJobs(j.jobs);
      setFactCount(m.facts.length);
      setTasks(ts.tasks);
      setUnread(n.unread);
      setError(null);
    } catch (caught) {
      setConnected(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function runMutation(action: () => Promise<unknown>): Promise<boolean> {
    setMutating(true);
    try {
      await action();
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setMutating(false);
    }
  }

  async function addTask() {
    const title = newTaskTitle.trim();
    if (!title) return;
    const saved = await runMutation(() => api.createTask({ title }));
    if (saved) setNewTaskTitle('');
  }

  function cycleTaskStatus(task: Task): TaskStatus {
    const order: TaskStatus[] = ['todo', 'in_progress', 'done'];
    const idx = order.indexOf(task.status);
    return order[(idx + 1) % order.length] ?? 'todo';
  }

  const enabledTools = tools.filter((tool) => tool.enabled).length;

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <div className="grid items-center gap-5 xl:grid-cols-[1fr_1.4fr_1fr]">
        <div className="hidden xl:block">
          <MetricStack
            items={[
              ['API link', connected ? 'online' : 'offline'],
              ['Pending actions', confirmations.length.toString().padStart(2, '0')],
              ['Scheduled jobs', jobs.length.toString().padStart(2, '0')],
            ]}
          />
        </div>

        <SystemCore
          compact
          state={!connected ? 'offline' : kill?.engaged ? 'halted' : error ? 'error' : 'idle'}
          connected={connected}
          killEngaged={Boolean(kill?.engaged)}
          toolCount={enabledTools}
          model={runtime ? `${runtime.provider} / ${runtime.model}` : 'detecting provider'}
        />

        <div className="hidden xl:block">
          <MetricStack
            align="right"
            items={[
              ['Memory facts', factCount.toString().padStart(2, '0')],
              ['Active tools', enabledTools.toString().padStart(2, '0')],
              ['Unread alerts', unread.toString().padStart(2, '0')],
            ]}
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="border border-ares-red/50 bg-ares-red/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.12em] text-red-200 shadow-hud-red">
          <span className="mr-2 text-ares-red">System alert:</span>
          {error}. Confirm that `npm run serve` is running.
        </div>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-12">
        <HudPanel title="Autonomy control" code="CTL-01" accent={kill?.engaged ? 'red' : 'cyan'} className="xl:col-span-5">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="hud-label">Global kill switch</div>
              <div className={`mt-2 font-mono text-xl font-semibold uppercase tracking-[0.16em] ${kill?.engaged ? 'text-ares-red' : 'text-ares-green'}`}>
                {kill?.engaged ? 'Autonomy halted' : 'Systems operational'}
              </div>
              <p className="mt-2 max-w-lg text-sm leading-6 text-slate-400">
                {kill?.engaged
                  ? kill.reason || 'All autonomous activity is paused.'
                  : 'Autonomous runners may execute scheduled and triggered work.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={kill?.engaged ? 'true' : 'false'}
              disabled={!kill || mutating}
              onClick={() => void runMutation(() => api.setKillSwitch(!kill?.engaged, 'via HUD dashboard'))}
              className={`relative h-16 w-32 shrink-0 border font-mono text-[10px] uppercase tracking-[0.16em] transition ${
                kill?.engaged
                  ? 'border-ares-red bg-ares-red/15 text-ares-red shadow-hud-red'
                  : 'border-ares-cyan/60 bg-ares-cyan/10 text-ares-cyan shadow-hud-cyan'
              } disabled:opacity-40`}
            >
              <span className={`absolute top-2 h-12 w-12 border transition-all ${kill?.engaged ? 'left-[72px] border-ares-red bg-ares-red/25' : 'left-2 border-ares-cyan bg-ares-cyan/20'}`} />
              <span className="absolute inset-x-0 bottom-1">{kill?.engaged ? 'Resume' : 'Engage'}</span>
            </button>
          </div>
        </HudPanel>

        <HudPanel title="Confirmation queue" code={`QUE-${confirmations.length.toString().padStart(2, '0')}`} accent="amber" className="xl:col-span-7">
          <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
            {confirmations.length === 0 && <EmptyState text="No actions awaiting principal authorization" />}
            {confirmations.map((confirmation) => (
              <div key={confirmation.id} className="grid gap-3 border-l-2 border-ares-amber/60 bg-black/25 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="font-mono text-xs uppercase tracking-[0.12em] text-ares-amber">{confirmation.tool}</div>
                  <div className="mt-1 break-words font-mono text-[10px] leading-5 text-slate-400">{JSON.stringify(confirmation.input)}</div>
                  {confirmation.reason && <div className="mt-1 text-xs text-slate-500">{confirmation.reason}</div>}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="border border-ares-green/50 bg-ares-green/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ares-green transition hover:bg-ares-green/20 disabled:opacity-40"
                    disabled={mutating}
                    onClick={() => void runMutation(() => api.resolve(confirmation.id, 'approved'))}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="border border-ares-red/50 bg-ares-red/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ares-red transition hover:bg-ares-red/20 disabled:opacity-40"
                    disabled={mutating}
                    onClick={() => void runMutation(() => api.resolve(confirmation.id, 'denied'))}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </HudPanel>

        <HudPanel title="Capability summary" code="CAP-20" className="xl:col-span-12">
          <div className="mb-4 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em]">
            <Link href="/memory" className="border border-ares-line px-3 py-2 text-ares-muted transition hover:border-ares-cyan/40 hover:text-ares-cyan">
              Memory browser →
            </Link>
            <Link href="/activity" className="border border-ares-line px-3 py-2 text-ares-muted transition hover:border-ares-cyan/40 hover:text-ares-cyan">
              Action log →
            </Link>
            <Link href="/tools" className="border border-ares-line px-3 py-2 text-ares-muted transition hover:border-ares-cyan/40 hover:text-ares-cyan">
              Tool settings →
            </Link>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Capability name="Reasoning engine" detail={runtime ? `${runtime.provider} / ${runtime.model}` : 'Detecting'} enabled={Boolean(runtime)} />
            <Capability name="Personal memory" detail={runtime?.persistentMemory ? 'Postgres + semantic retrieval' : 'Ephemeral memory only'} enabled={Boolean(runtime?.persistentMemory)} warning={!runtime?.persistentMemory} />
            <Capability name="Web research" detail="Search + guarded page retrieval" enabled={Boolean(runtime?.webSearchEnabled)} warning={!runtime?.webSearchEnabled} />
            <Capability name="Connected apps" detail={runtime?.connectors.length ? runtime.connectors.join(', ') : 'Configure Gmail, Calendar, Drive via MCP'} enabled={Boolean(runtime?.connectors.length)} warning={!runtime?.connectors.length} />
            <Capability name="Automation engine" detail={jobs.length ? `${jobs.length} scheduled operations` : 'Scheduler daemon not active'} enabled={jobs.length > 0} warning={jobs.length === 0} />
            <Capability name="Voice conversation" detail={runtime?.voiceEnabled ? 'STT + TTS configured' : 'Configure STT and TTS'} enabled={Boolean(runtime?.voiceEnabled)} warning={!runtime?.voiceEnabled} />
            <Capability name="Approval safety" detail={`${confirmations.length} pending gated actions`} enabled />
            <Capability name="Tooling" detail={`${enabledTools} of ${tools.length} tools active`} enabled={enabledTools > 0} />
          </div>
        </HudPanel>

        <HudPanel title="Scheduled operations" code="AUT-02" accent="amber" className="xl:col-span-5">
          <div className="space-y-3">
            {jobs.length === 0 && <EmptyState text="No jobs registered. Start the scheduler daemon." />}
            {jobs.map((job) => (
              <div key={job.name} className="flex items-center justify-between gap-3 border-b border-ares-line/60 pb-3">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.1em] text-slate-200">{job.name}</div>
                  <div className="mt-1 font-mono text-[10px] text-ares-muted">Cron sequence: {job.cron}</div>
                </div>
                <span className="h-2 w-2 shrink-0 rounded-full bg-ares-amber shadow-[0_0_10px_#ff9f1c]" />
              </div>
            ))}
          </div>
        </HudPanel>

        <HudPanel title={`Task queue / ${tasks.length}`} code="TSK-03" accent="amber" className="xl:col-span-7">
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addTask();
            }}
          >
            <label htmlFor="new-task" className="sr-only">New task</label>
            <input
              id="new-task"
              className="hud-input h-10 min-w-0 flex-1 px-3"
              placeholder="Add a task for ARES to track..."
              value={newTaskTitle}
              onChange={(event) => setNewTaskTitle(event.target.value)}
              disabled={mutating}
            />
            <button type="submit" className="hud-button" disabled={mutating || !newTaskTitle.trim()}>Add</button>
          </form>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {tasks.length === 0 && <EmptyState text="No tasks tracked" />}
            {tasks.map((task) => (
              <div key={task.id} className="flex items-center gap-3 border-l-2 border-ares-amber/50 bg-black/20 px-3 py-2">
                <button
                  type="button"
                  title="Cycle status"
                  disabled={mutating}
                  onClick={() => void runMutation(() => api.updateTask(task.id, { status: cycleTaskStatus(task) }))}
                  className={`shrink-0 border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${taskStatusColor(task.status)}`}
                >
                  {task.status.replace('_', ' ')}
                </button>
                <span className={`min-w-0 flex-1 truncate text-sm ${task.status === 'done' || task.status === 'cancelled' ? 'text-ares-muted line-through' : 'text-slate-200'}`}>
                  {task.title}
                  {task.priority !== 'normal' && (
                    <span className="ml-2 font-mono text-[9px] uppercase tracking-wider text-ares-amber">{task.priority}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-ares-red/70 transition hover:text-ares-red"
                  disabled={mutating}
                  onClick={() => void runMutation(() => api.removeTask(task.id))}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </HudPanel>
      </div>
    </div>
  );
}
