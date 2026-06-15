/**
 * localStorage-backed conversation threads.
 *
 * The chat used to persist a single transcript under `ares.chat.history`. Threads let
 * the user keep several named conversations and switch between them: an index of
 * {@link ThreadMeta} lives under one key, each thread's messages under its own key, and
 * the active thread id is remembered separately. {@link migrateLegacyThread} folds the
 * old single-history blob into a first thread so nothing is lost on upgrade.
 *
 * Message storage is generic — the page owns the message shape; this module only reads
 * and writes JSON arrays keyed by thread id.
 */

export interface ThreadMeta {
  id: string;
  /** User-facing label; empty until derived from the first message. */
  title: string;
  /** ISO timestamp of the last change, for sorting most-recent-first. */
  updatedAt: string;
}

const THREADS_KEY = 'ares.threads';
const ACTIVE_KEY = 'ares.thread.active';
const LEGACY_KEY = 'ares.chat.history';
const threadKey = (id: string) => `ares.thread.${id}`;

export function newThreadId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full/blocked — non-fatal
  }
}

export function loadThreads(): ThreadMeta[] {
  const list = read<ThreadMeta[]>(THREADS_KEY, []);
  return Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string') : [];
}

export function saveThreads(list: ThreadMeta[]): void {
  write(THREADS_KEY, list);
}

export function readActiveThreadId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function writeActiveThreadId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // ignore
  }
}

export function loadThreadMessages<T>(id: string): T[] {
  const msgs = read<T[]>(threadKey(id), []);
  return Array.isArray(msgs) ? msgs : [];
}

export function saveThreadMessages<T>(id: string, messages: T[]): void {
  write(threadKey(id), messages);
}

export function removeThreadMessages(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(threadKey(id));
  } catch {
    // ignore
  }
}

/**
 * One-time upgrade: if there's no thread index yet, fold any legacy single-history blob
 * into a brand-new thread and return it. Returns null only when window is unavailable.
 */
export function migrateLegacyThread<T>(deriveTitle: (messages: T[]) => string): { meta: ThreadMeta; messages: T[] } {
  const legacy = read<T[]>(LEGACY_KEY, []);
  const messages = Array.isArray(legacy) ? legacy : [];
  const meta: ThreadMeta = {
    id: newThreadId(),
    title: deriveTitle(messages),
    updatedAt: new Date().toISOString(),
  };
  saveThreads([meta]);
  if (messages.length) saveThreadMessages(meta.id, messages);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(LEGACY_KEY);
    } catch {
      // ignore
    }
  }
  return { meta, messages };
}
