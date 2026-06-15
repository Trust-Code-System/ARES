'use client';

import type { ThreadMeta } from '@/lib/threads';

/**
 * Compact conversation-thread switcher for the chat header: a dropdown of saved threads
 * plus new / rename / delete controls. Purely presentational — the page owns the thread
 * state and persistence and passes the action callbacks in.
 */

export interface ThreadBarProps {
  threads: ThreadMeta[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ThreadBar({ threads, activeId, onSwitch, onNew, onRename, onDelete }: ThreadBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <select
        value={activeId}
        onChange={(event) => onSwitch(event.target.value)}
        title="Switch conversation thread"
        className="h-7 max-w-[140px] border border-ares-line bg-ares-bg px-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ares-cyan outline-none sm:max-w-[200px]"
      >
        {threads.map((thread) => (
          <option key={thread.id} value={thread.id}>
            {thread.title || 'Untitled'}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onNew}
        title="New thread"
        className="h-7 shrink-0 border border-ares-line px-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:border-ares-cyan/50 hover:text-ares-cyan"
      >
        + New
      </button>
      <button
        type="button"
        onClick={() => onRename(activeId)}
        title="Rename this thread"
        className="h-7 shrink-0 border border-ares-line px-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:border-ares-cyan/50 hover:text-ares-cyan"
      >
        Rename
      </button>
      {threads.length > 1 && (
        <button
          type="button"
          onClick={() => onDelete(activeId)}
          title="Delete this thread"
          className="h-7 shrink-0 border border-ares-line px-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:border-ares-red/50 hover:text-ares-red"
        >
          Delete
        </button>
      )}
    </div>
  );
}
