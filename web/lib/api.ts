/**
 * Tiny client for the ARES API server (src/server). Point NEXT_PUBLIC_ARES_API at
 * wherever `npm run serve` is listening (default http://localhost:3001).
 */

export const API_BASE = process.env.NEXT_PUBLIC_ARES_API ?? 'http://localhost:3001';

const SESSION_STORAGE_KEY = 'ares.session';
const REMEMBERED_KEY_STORAGE = 'ares.apikey';

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
 * The API key remembered on this device, if the user opted in. Storing the master
 * key locally is a convenience/security trade-off — it lets ARES silently re-open a
 * session after the server restarts (which wipes in-memory sessions) instead of
 * re-prompting — so it is strictly opt-in via {@link login}'s `remember` flag.
 */
export function getRememberedKey(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REMEMBERED_KEY_STORAGE);
}

function setRememberedKey(key: string | null): void {
  if (typeof window === 'undefined') return;
  if (key) window.localStorage.setItem(REMEMBERED_KEY_STORAGE, key);
  else window.localStorage.removeItem(REMEMBERED_KEY_STORAGE);
}

/**
 * Exchange the API key for a session token and persist it. When `remember` is set,
 * the key itself is stored so the session can be silently re-established later.
 * Throws UnauthorizedError when the key is rejected.
 */
export async function login(key: string, remember = false): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (res.status === 401) throw new UnauthorizedError('invalid api key');
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  const { token } = (await res.json()) as { token: string };
  setSessionToken(token);
  setRememberedKey(remember ? key : null);
}

/**
 * Ensure there's a usable session without prompting: if the current token probe
 * fails but a key is remembered on this device, silently re-login with it. Returns
 * true when a session is active afterwards. A stale remembered key is cleared so we
 * don't loop on it.
 */
export async function ensureSession(): Promise<boolean> {
  try {
    // Probe a protected endpoint (not /api/health, which is public) so a missing
    // or expired session surfaces as UnauthorizedError rather than a false pass.
    await api.killSwitch();
    return true;
  } catch (caught) {
    if (!(caught instanceof UnauthorizedError)) return true; // server down → let app's offline UI handle it
  }
  const remembered = getRememberedKey();
  if (!remembered) return false;
  try {
    await login(remembered, true);
    return true;
  } catch {
    setRememberedKey(null);
    return false;
  }
}

/** Best-effort logout: invalidate the session server-side and clear it (and any remembered key) locally. */
export async function logout(): Promise<void> {
  const token = getSessionToken();
  if (token) {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: authHeaders() }).catch(() => {});
  }
  setSessionToken(null);
  setRememberedKey(null);
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
export interface ActivityRecord { id: string; trigger: string; status: string; detail: string; runId: string | null; startedAt: string; finishedAt: string | null; }
export interface ToolInfo { name: string; kind: string; description: string; enabled: boolean; }
export interface SkillInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
  sourceRepo: string | null;
  version: string | null;
  scripts: number;
}
export interface SkillAudit {
  findings: unknown[];
  report: string;
}
export interface SkillImportResult {
  owner: string;
  repo: string;
  ref: string | null;
  url: string;
  dir: string;
  skillsInstalled: number;
  worstFinding: 'low' | 'medium' | 'high' | 'critical' | null;
  scanReport: string;
}
export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  source: string | null;
  namespace: string | null;
  installedAt: string | null;
}
export interface McpInstallInput {
  name: string;
  npmPackage?: string;
  packageArgs?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  namespace?: string;
  enabled?: boolean;
  overwrite?: boolean;
}
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
  | 'design'
  | 'data'
  | 'office'
  | 'automation'
  | 'hr'
  | 'communications';
export interface ExtractedUpload {
  name: string;
  kind: string;
  text: string;
  truncated: boolean;
}
export interface ModelOption {
  id: string;
  label: string;
  detail: string;
}
export interface RuntimeStatus {
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  fastModel: string;
  /** Selectable model options for the HUD switch (`auto` + per-provider tiers). May be empty. */
  modelOptions?: ModelOption[];
  /** Selectable response-depth levels for the HUD effort switch (quick/standard/deep). */
  effortLevels?: string[];
  voiceEnabled: boolean;
  voiceInputProvider: string | null;
  voiceOutputProvider: string | null;
  persistentMemory: boolean;
  webSearchEnabled: boolean;
  shellEnabled: boolean;
  pythonEnabled: boolean;
  systemActionsEnabled: boolean;
  tradingEnabled: boolean;
  githubEnabled: boolean;
  connectors: string[];
  capabilities?: Array<{
    id: string;
    label: string;
    enabled: boolean;
    detail: string;
    strength: 'core' | 'strong' | 'medium' | 'guarded' | 'external';
  }>;
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
  skills: () => json<{ skills: SkillInfo[] }>('/api/skills'),
  auditSkills: () => json<SkillAudit>('/api/skills/audit', { method: 'POST' }),
  enableSkill: (id: string) => json(`/api/skills/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
  disableSkill: (id: string) => json(`/api/skills/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
  importSkill: (input: { url: string; ref?: string; overwrite?: boolean; blockSeverity?: 'low' | 'medium' | 'high' | 'critical' }) =>
    json<{ installed: SkillImportResult }>('/api/skills/import', { method: 'POST', body: JSON.stringify(input) }),
  mcpServers: () => json<{ servers: McpServerInfo[]; note?: string }>('/api/mcp'),
  installMcp: (input: McpInstallInput) =>
    json<{ server: McpServerInfo; total: number }>('/api/mcp/install', { method: 'POST', body: JSON.stringify(input) }),
  setMcpEnabled: (name: string, enabled: boolean) =>
    json<{ name: string; enabled: boolean }>(`/api/mcp/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  removeMcp: (name: string) =>
    json<{ removed: boolean; name: string }>(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }),
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
  extract: async (file: File): Promise<ExtractedUpload> => {
    const res = await fetch(`${API_BASE}/api/extract?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', ...authHeaders() },
      body: file,
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `file extraction failed (${res.status})`);
    }
    return res.json() as Promise<ExtractedUpload>;
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
  options?: {
    mode?: AssistantMode;
    model?: string;
    effort?: string;
    signal?: AbortSignal;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      text,
      ...(options?.mode ? { mode: options.mode } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.effort && options.effort !== 'standard' ? { effort: options.effort } : {}),
      ...(options?.history?.length ? { history: options.history } : {}),
    }),
    signal: options?.signal,
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
