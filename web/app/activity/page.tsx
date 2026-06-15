'use client';

import { useCallback, useEffect, useState } from 'react';
import { HudPanel } from '@/components/HudPanel';
import { EmptyState, formatTime, statusColor, urgencyColor } from '@/lib/hud';
import { api, type ActivityRecord, type AuditEvent, type Notification } from '@/lib/api';

export default function ActionLog() {
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<AuditEvent[] | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, n] = await Promise.all([api.activity(), api.notifications()]);
      setActivity(a.activity);
      setNotifications(n.notifications);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function inspectRun(runId: string) {
    if (openRun === runId) {
      setOpenRun(null);
      setRunEvents(null);
      return;
    }
    setOpenRun(runId);
    setRunEvents(null);
    setRunLoading(true);
    try {
      setRunEvents((await api.run(runId)).events);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunLoading(false);
    }
  }

  async function markRead(id: string) {
    setMutating(true);
    try {
      await api.markNotificationRead(id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutating(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader title="Action log" subtitle="Autonomous runs, audit trail, and delivered notifications" />

      {error && (
        <div role="alert" className="border border-ares-red/50 bg-ares-red/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.12em] text-red-200 shadow-hud-red">
          <span className="mr-2 text-ares-red">System alert:</span>
          {error}. Confirm that `npm run serve` is running.
        </div>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-12">
        <HudPanel title={`Autonomous activity / ${activity.length}`} code="LOG-04" className="xl:col-span-7">
          <div className="max-h-[40rem] space-y-px overflow-y-auto bg-ares-line/60">
            {activity.length === 0 && <EmptyState text="No autonomous activity recorded" />}
            {activity.map((record) => (
              <div key={record.id} className="bg-ares-panel/95">
                <div className="grid gap-2 px-3 py-2 font-mono text-[10px] sm:grid-cols-[70px_84px_1fr_auto] sm:items-center">
                  <time className="text-ares-muted">{formatTime(record.startedAt)}</time>
                  <span className={statusColor(record.status)}>{record.status.toUpperCase()}</span>
                  <div className="min-w-0">
                    <span className="text-slate-200">{record.trigger}</span>
                    {record.detail && <span className="ml-2 text-slate-500">{record.detail}</span>}
                  </div>
                  {record.runId ? (
                    <button
                      type="button"
                      className="justify-self-start font-mono text-[9px] uppercase tracking-wider text-ares-cyan/70 transition hover:text-ares-cyan sm:justify-self-end"
                      onClick={() => void inspectRun(record.runId!)}
                    >
                      {openRun === record.runId ? 'Hide trace' : 'Inspect'}
                    </button>
                  ) : (
                    <span className="justify-self-start font-mono text-[9px] uppercase tracking-wider text-ares-muted sm:justify-self-end">
                      no run
                    </span>
                  )}
                </div>
                {openRun === record.runId && (
                  <div className="border-t border-ares-line/60 bg-black/30 px-3 py-2">
                    {runLoading && <div className="font-mono text-[10px] uppercase tracking-wider text-ares-muted">Loading trace…</div>}
                    {!runLoading && runEvents?.length === 0 && <EmptyState text="No audit events for this run" />}
                    {!runLoading && runEvents?.map((event, index) => (
                      <div key={`${event.ts}-${index}`} className="grid gap-2 py-1 font-mono text-[10px] sm:grid-cols-[64px_120px_1fr]">
                        <time className="text-ares-muted">{formatTime(event.ts)}</time>
                        <span className={event.type === 'refusal' || event.type === 'error' || event.type === 'tool_failed' ? 'text-ares-red' : 'text-ares-cyan'}>
                          {event.type}
                        </span>
                        <span className="min-w-0 break-words text-slate-400">{JSON.stringify(event.detail)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </HudPanel>

        <HudPanel title={`Notifications / ${notifications.length}`} code="NTF-05" className="xl:col-span-5">
          <div className="max-h-[40rem] space-y-2 overflow-y-auto pr-1">
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
                        onClick={() => void markRead(note.id)}
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
