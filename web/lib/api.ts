/**
 * Tiny client for the ARES API server (src/server). Point NEXT_PUBLIC_ARES_API at
 * wherever `npm run serve` is listening (default http://localhost:3001).
 */

export const API_BASE = process.env.NEXT_PUBLIC_ARES_API ?? 'http://localhost:3001';

const SESSION_STORAGE_KEY = 'ares.session';

/** Thrown when the server requires auth and the current credential is missing/invalid. */
export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Read the stored session token (browser only). */
export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SESSION_STORAGE_KEY);
}

function setSessionToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(SESSION_STORAGE_KEY, token);
  else window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

/** Authorization header for the current session, if any. */
export function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Exchange the API key for a session token and persist it. Throws
 * UnauthorizedError when the key is rejected.
 */
export async function login(key: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (res.status === 401) throw new UnauthorizedError('invalid api key');
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  const { token } = (await res.json()) as { token: string };
  setSessionToken(token);
}

/** Best-effort logout: invalidate the session server-side and clear it locally. */
export async function logout(): Promise<void> {
  const token = getSessionToken();
  if (token) {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: authHeaders() }).catch(() => {});
  }
  setSessionToken(null);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    setSessionToken(null);
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface AuditEvent { runId: string; ts: string; type: string; detail: Record<string, unknown>; }
export interface ActivityRecord { id: string; trigger: string; status: string; detail: string; startedAt: string; finishedAt: string | null; }
export interface ToolInfo { name: string; kind: string; description: string; enabled: boolean; }
export interface KillSwitchState { engaged: boolean; reason: string | null; changedAt: string; changedBy: string | null; }
export interface Confirmation { id: string; tool: string; input: unknown; reason: string; createdAt: string; }
export interface Fact { id: string; kind: string; subject: string; content: string; importance: number; }
export type FactKind = 'fact' | 'person' | 'project' | 'preference' | 'decision';
export interface SemanticHit { id: string; sourceType: string; content: string; similarity: number; createdAt: string; }
export interface Job { name: string; cron: string; }
export interface Notification {
  id: string;
  title: string;
  body: string;
  urgency: 'low' | 'normal' | 'high';
  sourceRun: string | null;
  createdAt: string;
  readAt: string | null;
}
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  detail: string;
  project: string | null;
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
}
export type AssistantMode =
  | 'general'
  | 'developer'
  | 'research'
  | 'business'
  | 'project'
  | 'document'
  | 'hr'
  | 'communications';
export interface RuntimeStatus {
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  fastModel: string;
  voiceEnabled: boolean;
  voiceInputProvider: string | null;
  voiceOutputProvider: string | null;
  persistentMemory: boolean;
  webSearchEnabled: boolean;
  shellEnabled: boolean;
  pythonEnabled: boolean;
  systemActionsEnabled: boolean;
  tradingEnabled: boolean;
  connectors: string[];
}

export const api = {
  health: () => json<{ ok: boolean }>('/api/health'),
  status: () => json<RuntimeStatus>('/api/status'),
  activity: () => json<{ activity: ActivityRecord[] }>('/api/activity'),
  run: (id: string) => json<{ events: AuditEvent[] }>(`/api/runs/${id}`),
  memory: (q?: string) => json<{ facts: Fact[] }>(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  remember: (fact: { kind: FactKind; subject: string; content: string; importance?: number }) =>
    json<{ fact: Fact }>('/api/memory', { method: 'POST', body: JSON.stringify(fact) }),
  forget: (id: string) => json<{ removed: boolean }>(`/api/memory/${id}`, { method: 'DELETE' }),
  semanticMemory: (q: string, k = 10) =>
    json<{ hits: SemanticHit[]; note?: string }>(`/api/memory/semantic?q=${encodeURIComponent(q)}&limit=${k}`),
  confirmations: () => json<{ pending: Confirmation[] }>('/api/confirmations'),
  resolve: (id: string, decision: 'approved' | 'denied') =>
    json(`/api/confirmations/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  killSwitch: () => json<{ state: KillSwitchState }>('/api/killswitch'),
  setKillSwitch: (engaged: boolean, reason?: string) =>
    json<{ state: KillSwitchState }>('/api/killswitch', { method: 'POST', body: JSON.stringify({ engaged, reason }) }),
  tools: () => json<{ tools: ToolInfo[] }>('/api/tools'),
  toggleTool: (name: string, enabled: boolean) =>
    json(`/api/tools/${name}`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  jobs: () => json<{ jobs: Job[] }>('/api/jobs'),
  notifications: () => json<{ notifications: Notification[]; unread: number }>('/api/notifications'),
  markNotificationRead: (id: string) =>
    json<{ notification: Notification }>(`/api/notifications/${id}/read`, { method: 'POST' }),
  tasks: (status?: TaskStatus) =>
    json<{ tasks: Task[] }>(`/api/tasks${status ? `?status=${status}` : ''}`),
  createTask: (task: { title: string; priority?: TaskPriority; detail?: string; project?: string; dueAt?: string }) =>
    json<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(task) }),
  updateTask: (id: string, update: { status?: TaskStatus; title?: string; priority?: TaskPriority; detail?: string }) =>
    json<{ task: Task }>(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify(update) }),
  removeTask: (id: string) => json<{ removed: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  speak: async (text: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/api/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) throw new Error(`speech synthesis failed (${res.status})`);
    return res.blob();
  },
  transcribe: async (audio: Blob, contentType: string): Promise<string> => {
    const res = await fetch(`${API_BASE}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': contentType, ...authHeaders() },
      body: audio,
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) throw new Error(`transcription failed (${res.status})`);
    return ((await res.json()) as { text: string }).text;
  },
};

/** Terminal payload of a chat stream (the `done` SSE frame). */
export interface ChatDone {
  runId: string;
  stopReason: 'completed' | 'refusal' | 'max_iterations' | 'aborted' | 'error';
  toolCalls: Array<{ name: string; ok: boolean }>;
}

/**
 * Stream a chat turn via SSE. Calls onToken for each chunk, onActivity with the
 * run's tool events, onDone when the run finishes (carrying the stop reason — a
 * run can finish with no tokens at all, e.g. an error or refusal), and onError
 * if the server reports the request itself was invalid. Resolves when the stream
 * closes.
 */
export async function streamChat(
  text: string,
  handlers: {
    onToken: (t: string) => void;
    onActivity?: (events: AuditEvent[]) => void;
    onDone?: (done: ChatDone) => void;
    onError?: (message: string) => void;
  },
  options?: { mode?: AssistantMode },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ text, ...(options?.mode ? { mode: options.mode } : {}) }),
  });
  if (res.status === 401) {
    setSessionToken(null);
    throw new UnauthorizedError();
  }
  if (!res.body) throw new Error('no response stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = /event: (.*)/.exec(frame)?.[1];
      const data = /data: (.*)/.exec(frame)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === 'token') handlers.onToken(payload.token);
      else if (event === 'activity') handlers.onActivity?.(payload.events);
      else if (event === 'done') handlers.onDone?.(payload as ChatDone);
      else if (event === 'error') handlers.onError?.(payload.error);
    }
  }
}
