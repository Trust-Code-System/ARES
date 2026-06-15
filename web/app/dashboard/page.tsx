'use client';

import { useCallback, useEffect, useState } from 'react';
import { HudPanel } from '@/components/HudPanel';
import { SystemCore } from '@/components/SystemCore';
import {
  api,
  type ActivityRecord,
  type Confirmation,
  type Fact,
  type FactKind,
  type Job,
  type KillSwitchState,
  type Notification,
  type RuntimeStatus,
  type SemanticHit,
  type Task,
  type TaskStatus,
  type ToolInfo,
} from '@/lib/api';

export default function Dashboard() {
  const [kill, setKill] = useState<KillSwitchState | null>(null);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [semQuery, setSemQuery] = useState('');
  const [semHits, setSemHits] = useState<SemanticHit[] | null>(null);
  const [memoryKind, setMemoryKind] = useState<FactKind>('fact');
  const [memorySubject, setMemorySubject] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [connected, setConnected] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [health, status, k, a, c, t, j, m, ts, n] = await Promise.all([
        api.health(),
        api.status(),
        api.killSwitch(),
        api.activity(),
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
      setActivity(a.activity);
      setConfirmations(c.pending);
      setTools(t.tools);
      setJobs(j.jobs);
      setFacts(m.facts);
      setTasks(ts.tasks);
      setNotifications(n.notifications);
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

  async function rememberFact() {
    if (!memorySubject.trim() || !memoryContent.trim()) return;
    const saved = await runMutation(() => api.remember({
      kind: memoryKind,
      subject: memorySubject.trim(),
      content: memoryContent.trim(),
    }));
    if (saved) {
      setMemorySubject('');
      setMemoryContent('');
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

  async function searchSemantic() {
    if (!semQuery.trim()) {
      setSemHits(null);
      return;
    }
    try {
      setSemHits((await api.semanticMemory(semQuery)).hits);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
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
              ['Memory facts', facts.length.toString().padStart(2, '0')],
              ['Active tools', enabledTools.toString().padStart(2, '0')],
              ['Activity records', activity.length.toString().padStart(2, '0')],
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
              aria-checked={Boolean(kill?.engaged)}
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

        <HudPanel title="Capability command center" code="CAP-20" className="xl:col-span-12">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Capability name="Reasoning engine" detail={runtime ? `${runtime.provider} / ${runtime.model}` : 'Detecting'} enabled={Boolean(runtime)} />
            <Capability
              name="Voice conversation"
              detail={runtime?.voiceEnabled
                ? `${runtime.voiceInputProvider ?? 'configured'} input + ${runtime.voiceOutputProvider ?? 'configured'} speech`
                : 'Configure Gemini/OpenAI STT and ElevenLabs/OpenAI TTS'}
              enabled={Boolean(runtime?.voiceEnabled)}
            />
            <Capability name="Personal memory" detail={runtime?.persistentMemory ? 'Postgres + semantic retrieval' : 'Ephemeral memory only'} enabled={Boolean(runtime?.persistentMemory)} warning={!runtime?.persistentMemory} />
            <Capability name="Web research" detail="Search + guarded page retrieval" enabled={Boolean(runtime?.webSearchEnabled)} />
            <Capability name="Document workspace" detail={tools.some((tool) => tool.name === 'extract_image_text') ? 'Files + PDF, DOCX, spreadsheets, and image OCR' : 'Files + PDF, DOCX, and spreadsheets'} enabled={tools.some((tool) => tool.name === 'read_pdf')} />
            <Capability name="Python execution" detail="Confirmation-gated isolated Python runner" enabled={Boolean(runtime?.pythonEnabled)} warning={!runtime?.pythonEnabled} />
            <Capability name="System actions" detail="Open approved apps and HTTP(S) websites" enabled={Boolean(runtime?.systemActionsEnabled)} warning={!runtime?.systemActionsEnabled} />
            <Capability name="Connected apps" detail={runtime?.connectors.length ? runtime.connectors.join(', ') : 'Configure Gmail, Calendar, Slack, Drive via MCP'} enabled={Boolean(runtime?.connectors.length)} warning={!runtime?.connectors.length} />
            <Capability name="Automation engine" detail={jobs.length ? `${jobs.length} scheduled operations` : 'Scheduler daemon not active'} enabled={jobs.length > 0} warning={jobs.length === 0} />
            <Capability name="Approval safety" detail={`${confirmations.length} pending gated actions`} enabled />
            <Capability name="Project manager" detail="Available as a chat specialist mode" enabled />
            <Capability name="Business advisor" detail="Available as a chat specialist mode" enabled />
            <Capability name="HR specialist" detail="Available as a chat specialist mode" enabled />
          </div>
        </HudPanel>

        <HudPanel title="Tool matrix" code={`TLS-${tools.length.toString().padStart(2, '0')}`} className="xl:col-span-7">
          <div className="grid max-h-[430px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {tools.map((tool) => (
              <label key={tool.name} className="group flex cursor-pointer items-center gap-3 border border-ares-line bg-black/20 p-3 transition hover:border-ares-cyan/40 hover:bg-ares-cyan/[0.04]">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={tool.enabled}
                  disabled={mutating}
                  onChange={() => void runMutation(() => api.toggleTool(tool.name, !tool.enabled))}
                />
                <span className="grid h-8 w-8 shrink-0 place-items-center border border-ares-line bg-black/40 transition peer-checked:border-ares-cyan peer-checked:bg-ares-cyan/15 peer-checked:shadow-hud-cyan">
                  <span className={`h-2 w-2 transition ${tool.enabled ? 'bg-ares-cyan shadow-[0_0_8px_#00d9ff]' : 'bg-ares-muted'}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-slate-200">{tool.name}</span>
                  <span className="mt-1 block truncate text-[10px] text-ares-muted">{tool.description}</span>
                </span>
                <span className={`font-mono text-[9px] uppercase tracking-wider ${tool.kind === 'state_mutating' ? 'text-ares-amber' : 'text-ares-cyan'}`}>
                  {tool.kind === 'state_mutating' ? 'gated' : 'read'}
                </span>
              </label>
            ))}
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

        <HudPanel title={`Notifications / ${notifications.length}`} code="NTF-05" className="xl:col-span-5">
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {notifications.length === 0 && <EmptyState text="No notifications delivered" />}
            {notifications.map((note) => (
              <article
                key={note.id}
                className={`border-l-2 bg-black/20 px-3 py-2 ${note.readAt ? 'border-ares-line' : 'border-ares-cyan/60'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className={`font-mono text-[9px] uppercase tracking-[0.14em] ${urgencyColor(note.urgency)}`}>{note.urgency}</span>
                  <div className="flex items-center gap-2">
                    <time className="font-mono text-[9px] text-ares-muted">{formatTime(note.createdAt)}</time>
                    {!note.readAt && (
                      <button
                        type="button"
                        className="font-mono text-[9px] uppercase tracking-wider text-ares-cyan/80 transition hover:text-ares-cyan"
                        disabled={mutating}
                        onClick={() => void runMutation(() => api.markNotificationRead(note.id))}
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-sm text-slate-200">{note.title}</div>
                <p className="mt-0.5 text-xs leading-5 text-slate-400">{note.body}</p>
              </article>
            ))}
          </div>
        </HudPanel>

        <HudPanel title="Autonomous activity" code="LOG-04" className="xl:col-span-7">
          <div className="max-h-80 overflow-y-auto">
            {activity.length === 0 && <EmptyState text="No autonomous activity recorded" />}
            <div className="space-y-px bg-ares-line/60">
              {activity.map((record) => (
                <div key={record.id} className="grid gap-2 bg-ares-panel/95 px-3 py-2 font-mono text-[10px] sm:grid-cols-[70px_80px_1fr] sm:items-center">
                  <time className="text-ares-muted">{formatTime(record.startedAt)}</time>
                  <span className={statusColor(record.status)}>{record.status.toUpperCase()}</span>
                  <div className="min-w-0">
                    <span className="text-slate-200">{record.trigger}</span>
                    {record.detail && <span className="ml-2 text-slate-500">{record.detail}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </HudPanel>

        <HudPanel title={`Structured memory / ${facts.length} facts`} code="MEM-01" accent="amber" className="xl:col-span-5">
          <form
            className="mb-4 space-y-2 border border-ares-line bg-black/20 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void rememberFact();
            }}
          >
            <div className="flex gap-2">
              <select
                aria-label="Memory type"
                value={memoryKind}
                onChange={(event) => setMemoryKind(event.target.value as FactKind)}
                className="border border-ares-line bg-ares-bg px-2 font-mono text-[10px] uppercase text-ares-amber outline-none"
              >
                {FACT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
              <input
                aria-label="Memory subject"
                className="hud-input h-9 min-w-0 flex-1 px-2 text-xs"
                placeholder="Subject, project, or person"
                value={memorySubject}
                onChange={(event) => setMemorySubject(event.target.value)}
              />
            </div>
            <textarea
              aria-label="Memory content"
              className="hud-input min-h-20 w-full resize-y px-2 py-2 text-xs"
              placeholder="What should ARES remember?"
              value={memoryContent}
              onChange={(event) => setMemoryContent(event.target.value)}
            />
            <button type="submit" className="hud-button w-full" disabled={mutating || !memorySubject.trim() || !memoryContent.trim()}>
              Commit memory
            </button>
          </form>
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {facts.length === 0 && <EmptyState text="No structured facts available" />}
            {facts.map((fact) => (
              <article key={fact.id} className="border-l border-ares-amber/50 bg-black/20 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ares-amber">{fact.kind}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] text-ares-muted">IMP {fact.importance}</span>
                    <button
                      type="button"
                      className="font-mono text-[9px] uppercase tracking-wider text-ares-red/70 transition hover:text-ares-red"
                      disabled={mutating}
                      onClick={() => void runMutation(() => api.forget(fact.id))}
                    >
                      Forget
                    </button>
                  </div>
                </div>
                <div className="mt-1 text-sm text-slate-200">
                  <strong className="font-medium text-ares-cyanSoft">{fact.subject}:</strong> {fact.content}
                </div>
              </article>
            ))}
          </div>
        </HudPanel>

        <HudPanel title="Semantic memory probe" code="VEC-02" className="xl:col-span-7">
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void searchSemantic();
            }}
          >
            <label htmlFor="semantic-query" className="sr-only">Search semantic memory</label>
            <input
              id="semantic-query"
              className="hud-input h-10 min-w-0 flex-1 px-3"
              placeholder="Search conversation memory by meaning..."
              value={semQuery}
              onChange={(event) => setSemQuery(event.target.value)}
            />
            <button type="submit" className="hud-button" disabled={!semQuery.trim()}>Probe</button>
          </form>

          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {semHits === null && <EmptyState text="Enter a query to scan embedded memory" />}
            {semHits?.length === 0 && <EmptyState text="No matching memory vectors" />}
            {semHits?.map((hit) => (
              <article key={hit.id} className="border border-ares-line bg-black/20 p-3">
                <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.12em]">
                  <span className="text-ares-cyan">{hit.sourceType}</span>
                  <span className="text-ares-muted">Similarity {hit.similarity.toFixed(3)}</span>
                </div>
                <p className="text-sm leading-6 text-slate-300">{hit.content}</p>
              </article>
            ))}
          </div>
        </HudPanel>
      </div>
    </div>
  );
}

const FACT_KINDS: FactKind[] = ['fact', 'person', 'project', 'preference', 'decision'];

function MetricStack({ items, align = 'left' }: { items: Array<[string, string]>; align?: 'left' | 'right' }) {
  return (
    <div className={`space-y-4 ${align === 'right' ? 'text-right' : ''}`}>
      {items.map(([label, value]) => (
        <div key={label} className={align === 'right' ? 'border-r border-ares-cyan/35 pr-3' : 'border-l border-ares-cyan/35 pl-3'}>
          <div className="hud-label">{label}</div>
          <div className="hud-value mt-1">{value}</div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="border border-dashed border-ares-line px-4 py-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ares-muted">
      {text}
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false });
}

function statusColor(status: string): string {
  if (status === 'failed' || status === 'aborted') return 'text-ares-red';
  if (status === 'skipped') return 'text-ares-amber';
  if (status === 'completed') return 'text-ares-green';
  return 'text-ares-cyan';
}

function taskStatusColor(status: string): string {
  if (status === 'done') return 'border-ares-green/50 text-ares-green';
  if (status === 'in_progress') return 'border-ares-cyan/50 text-ares-cyan';
  if (status === 'cancelled') return 'border-ares-line text-ares-muted';
  return 'border-ares-amber/50 text-ares-amber';
}

function urgencyColor(urgency: string): string {
  if (urgency === 'high') return 'text-ares-red';
  if (urgency === 'low') return 'text-ares-muted';
  return 'text-ares-cyan';
}

function Capability({
  name,
  detail,
  enabled,
  warning = false,
}: {
  name: string;
  detail: string;
  enabled: boolean;
  warning?: boolean;
}) {
  const color = enabled
    ? 'border-ares-cyan/40 text-ares-cyan'
    : warning
      ? 'border-ares-amber/40 text-ares-amber'
      : 'border-ares-line text-ares-muted';
  return (
    <div className={`min-w-0 border bg-black/20 p-3 ${color}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em]">{name}</span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-ares-cyan shadow-[0_0_8px_#00d9ff]' : warning ? 'bg-ares-amber' : 'bg-ares-muted'}`} />
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-400">{detail}</p>
      <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em]">
        {enabled ? 'Operational' : 'Setup required'}
      </div>
    </div>
  );
}
