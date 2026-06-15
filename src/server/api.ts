/**
 * The HTTP API behind the Phase-5 web interface.
 *
 * Everything the chat UI and the dashboard need is exposed here as small JSON
 * endpoints over the EXISTING backends — there is no new business logic, just a
 * read/command surface: run the agent, browse memory + the activity feed + the
 * audit trail, list/toggle tools, list scheduled jobs, read/flip the kill switch,
 * and approve/deny queued confirmations.
 *
 * {@link ApiHandler.handle} is pure request→response (no sockets), so it's unit-
 * tested directly; httpServer.ts is the thin node:http adapter around it.
 */

import type { AgentEventHandlers, AgentInput, AgentRunResult, AuditLog } from '../types.js';
import type { ActivityFeed, KillSwitch } from '../autonomy/store.js';
import type { Scheduler } from '../autonomy/scheduler.js';
import type { ConfirmationQueueStore, StandingRulesStore } from '../safety/store.js';
import type { SemanticStore, StructuredStore } from '../memory/stores.js';
import type { EmbeddingClient } from '../memory/embeddings.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolPermissionStore } from '../tools/permissions.js';
import type { NotificationStore } from '../notifications/store.js';
import { TASK_STATUSES, type TaskStatus, type TaskStore } from '../tasks/store.js';
import type { VoiceProvider } from './voice.js';
import {
  chatSchema,
  confirmationSchema,
  createTaskSchema,
  killSwitchSchema,
  parseBody,
  rememberSchema,
  toggleToolSchema,
  updateTaskSchema,
} from './schemas.js';

export interface AgentLike {
  run(
    input: AgentInput,
    signal?: AbortSignal,
    events?: AgentEventHandlers,
  ): Promise<AgentRunResult>;
}

export interface ApiDeps {
  agent: AgentLike;
  audit: AuditLog;
  activityFeed: ActivityFeed;
  killSwitch: KillSwitch;
  rules: StandingRulesStore;
  queue: ConfirmationQueueStore;
  structured: StructuredStore;
  registry: ToolRegistry;
  /** Persists tool enable/disable toggles so they survive a restart. Optional. */
  toolPermissions?: ToolPermissionStore;
  /** Notification history. Optional (absent in minimal/test setups). */
  notifications?: NotificationStore;
  /** Task store. Optional (absent in minimal/test setups). */
  tasks?: TaskStore;
  scheduler?: Scheduler;
  /** Optional voice provider for the /api/voice/* endpoints (httpServer.ts). */
  voice?: VoiceProvider;
  /** Semantic store + embedder for the /api/memory/semantic browse endpoint. */
  semantic?: SemanticStore;
  embeddings?: EmbeddingClient;
  runtime?: {
    provider: 'anthropic' | 'openai' | 'gemini';
    model: string;
    fastModel: string;
    voiceEnabled: boolean;
    voiceInputProvider?: string;
    voiceOutputProvider?: string;
    persistentMemory: boolean;
    webSearchEnabled: boolean;
    shellEnabled: boolean;
    pythonEnabled?: boolean;
    systemActionsEnabled?: boolean;
    tradingEnabled: boolean;
    githubEnabled?: boolean;
    connectors: string[];
  };
}

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export class ApiHandler {
  constructor(private readonly deps: ApiDeps) {}

  async handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.route(req);
    } catch (err) {
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async route(req: ApiRequest): Promise<ApiResponse> {
    const { method, path } = req;
    const seg = path.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','chat']

    if (method === 'GET' && path === '/api/health') return ok({ ok: true });
    if (method === 'GET' && path === '/api/status') {
      return ok({
        provider: this.deps.runtime?.provider ?? 'anthropic',
        model: this.deps.runtime?.model ?? 'unknown',
        fastModel: this.deps.runtime?.fastModel ?? 'unknown',
        voiceEnabled: this.deps.runtime?.voiceEnabled ?? Boolean(this.deps.voice),
        voiceInputProvider: this.deps.runtime?.voiceInputProvider ?? this.deps.voice?.sttProvider ?? null,
        voiceOutputProvider: this.deps.runtime?.voiceOutputProvider ?? this.deps.voice?.ttsProvider ?? null,
        persistentMemory: this.deps.runtime?.persistentMemory ?? false,
        webSearchEnabled: this.deps.runtime?.webSearchEnabled ?? this.deps.registry.has('web_search'),
        shellEnabled: this.deps.runtime?.shellEnabled ?? this.deps.registry.has('run_command'),
        pythonEnabled: this.deps.runtime?.pythonEnabled ?? this.deps.registry.has('run_python'),
        systemActionsEnabled: this.deps.runtime?.systemActionsEnabled ?? this.deps.registry.has('open_application'),
        tradingEnabled: this.deps.runtime?.tradingEnabled ?? this.deps.registry.has('place_trade'),
        githubEnabled: this.deps.runtime?.githubEnabled ?? this.deps.registry.has('github_search'),
        connectors: this.deps.runtime?.connectors ?? [],
      });
    }

    if (method === 'POST' && path === '/api/chat') return this.chat(req);

    if (method === 'GET' && path === '/api/activity') {
      return ok({ activity: await this.deps.activityFeed.recent(limit(req, 50)) });
    }

    if (method === 'GET' && seg[1] === 'runs' && seg[2]) {
      return ok({ runId: seg[2], events: this.deps.audit.forRun(seg[2]) });
    }

    if (method === 'GET' && path === '/api/memory') {
      const q = req.query.get('q');
      const facts = q
        ? await this.deps.structured.search(q, limit(req, 50))
        : await this.deps.structured.all();
      return ok({ facts });
    }
    if (method === 'POST' && path === '/api/memory') return this.remember(req.body);
    if (method === 'DELETE' && seg[1] === 'memory' && seg[2]) {
      const removed = await this.deps.structured.remove(seg[2]);
      return removed
        ? ok({ removed: true })
        : { status: 404, body: { error: 'no active memory with that id' } };
    }

    if (method === 'GET' && path === '/api/memory/semantic') return this.semanticMemory(req);

    if (method === 'GET' && path === '/api/confirmations') {
      return ok({ pending: await this.deps.queue.pending() });
    }
    if (method === 'POST' && seg[1] === 'confirmations' && seg[2]) {
      return this.resolveConfirmation(seg[2], req.body);
    }

    if (method === 'GET' && path === '/api/killswitch') {
      return ok({ state: await this.deps.killSwitch.state() });
    }
    if (method === 'POST' && path === '/api/killswitch') return this.setKillSwitch(req.body);

    if (method === 'GET' && path === '/api/tools') return ok({ tools: this.deps.registry.catalog() });
    if (method === 'POST' && seg[1] === 'tools' && seg[2]) return this.toggleTool(seg[2], req.body);

    if (method === 'GET' && path === '/api/notifications') return this.listNotifications(req);
    if (method === 'POST' && seg[1] === 'notifications' && seg[2] && seg[3] === 'read') {
      return this.markNotificationRead(seg[2]);
    }

    if (method === 'GET' && path === '/api/tasks') return this.listTasks(req);
    if (method === 'POST' && path === '/api/tasks') return this.createTask(req.body);
    if (method === 'POST' && seg[1] === 'tasks' && seg[2]) return this.updateTask(seg[2], req.body);
    if (method === 'DELETE' && seg[1] === 'tasks' && seg[2]) return this.removeTask(seg[2]);

    if (method === 'GET' && path === '/api/jobs') {
      const jobs = (this.deps.scheduler?.jobs() ?? []).map((j) => ({ name: j.name, cron: j.cron }));
      return ok({ jobs });
    }

    if (method === 'GET' && path === '/api/rules') return ok({ rules: await this.deps.rules.list() });

    return { status: 404, body: { error: `no route for ${method} ${path}` } };
  }

  private async chat(req: ApiRequest): Promise<ApiResponse> {
    const parsed = parseBody(chatSchema, req.body);
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await this.deps.agent.run({
      text: parsed.data.text,
      source: 'user',
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
    });
    return ok({
      runId: result.runId,
      finalText: result.finalText,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      events: this.deps.audit.forRun(result.runId),
    });
  }

  /**
   * Semantic memory browse: embed the query, then return the top-k chunks by
   * cosine similarity. Unlike structured facts (which can be listed wholesale),
   * semantic memory is only meaningful relative to a query, so `q` is required.
   * Returns an empty set with a note if no semantic store/embedder is wired.
   */
  private async semanticMemory(req: ApiRequest): Promise<ApiResponse> {
    const q = req.query.get('q');
    if (!q || !q.trim()) return { status: 400, body: { error: 'query param q is required' } };
    if (!this.deps.semantic || !this.deps.embeddings) {
      return ok({ hits: [], note: 'semantic memory is not configured on this server' });
    }
    const [embedding] = await this.deps.embeddings.embed([q], 'query');
    const hits = await this.deps.semantic.search(embedding ?? [], limit(req, 10));
    return ok({ hits });
  }

  private async remember(body: unknown): Promise<ApiResponse> {
    const parsed = parseBody(rememberSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const fact = await this.deps.structured.upsert({
      kind: parsed.data.kind,
      subject: parsed.data.subject.trim(),
      content: parsed.data.content.trim(),
      importance: parsed.data.importance ?? 0.8,
      confidence: 1,
      attributes: { explicit: true, source: 'ui' },
    });
    return ok({ fact });
  }

  private async resolveConfirmation(id: string, body: unknown): Promise<ApiResponse> {
    const parsed = parseBody(confirmationSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const resolved = await this.deps.queue.resolve(id, parsed.data.decision, 'ui');
    if (!resolved) return { status: 404, body: { error: 'no pending confirmation with that id' } };
    return ok({ resolved });
  }

  private async setKillSwitch(body: unknown): Promise<ApiResponse> {
    const parsed = parseBody(killSwitchSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const reason = parsed.data.reason ?? 'via dashboard';
    const state = parsed.data.engaged
      ? await this.deps.killSwitch.engage(reason, 'ui')
      : await this.deps.killSwitch.disengage('ui');
    return ok({ state });
  }

  private async toggleTool(name: string, body: unknown): Promise<ApiResponse> {
    const parsed = parseBody(toggleToolSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const enabled = parsed.data.enabled;
    if (!this.deps.registry.setEnabled(name, enabled)) {
      return { status: 404, body: { error: `no tool named "${name}"` } };
    }
    // Persist the override so it survives a restart (best-effort: the in-memory
    // toggle already applied, and a persistence failure shouldn't 500 the UI).
    if (this.deps.toolPermissions) {
      await this.deps.toolPermissions.setEnabled(name, enabled, 'ui');
    }
    return ok({ name, enabled: this.deps.registry.isEnabled(name) });
  }

  private async listNotifications(req: ApiRequest): Promise<ApiResponse> {
    if (!this.deps.notifications) return ok({ notifications: [], unread: 0 });
    const [notifications, unread] = await Promise.all([
      this.deps.notifications.recent(limit(req, 50)),
      this.deps.notifications.unreadCount(),
    ]);
    return ok({ notifications, unread });
  }

  private async markNotificationRead(id: string): Promise<ApiResponse> {
    if (!this.deps.notifications) return { status: 404, body: { error: 'notifications are not configured' } };
    const updated = await this.deps.notifications.markRead(id);
    return updated ? ok({ notification: updated }) : { status: 404, body: { error: 'no notification with that id' } };
  }

  private async listTasks(req: ApiRequest): Promise<ApiResponse> {
    if (!this.deps.tasks) return ok({ tasks: [] });
    const statusParam = req.query.get('status');
    if (statusParam && !TASK_STATUSES.includes(statusParam as TaskStatus)) {
      return { status: 400, body: { error: `status must be one of ${TASK_STATUSES.join(', ')}` } };
    }
    const tasks = await this.deps.tasks.list({
      ...(statusParam ? { status: [statusParam as TaskStatus] } : {}),
      limit: limit(req, 100),
    });
    return ok({ tasks });
  }

  private async createTask(body: unknown): Promise<ApiResponse> {
    if (!this.deps.tasks) return { status: 404, body: { error: 'tasks are not configured' } };
    const parsed = parseBody(createTaskSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const input = parsed.data;
    const task = await this.deps.tasks.create({
      title: input.title.trim(),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    });
    return ok({ task });
  }

  private async updateTask(id: string, body: unknown): Promise<ApiResponse> {
    if (!this.deps.tasks) return { status: 404, body: { error: 'tasks are not configured' } };
    const parsed = parseBody(updateTaskSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const input = parsed.data;
    const updated = await this.deps.tasks.update(id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    });
    return updated ? ok({ task: updated }) : { status: 404, body: { error: 'no task with that id' } };
  }

  private async removeTask(id: string): Promise<ApiResponse> {
    if (!this.deps.tasks) return { status: 404, body: { error: 'tasks are not configured' } };
    const removed = await this.deps.tasks.remove(id);
    return removed ? ok({ removed: true }) : { status: 404, body: { error: 'no task with that id' } };
  }
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function badRequest(error: string): ApiResponse {
  return { status: 400, body: { error } };
}

function limit(req: ApiRequest, fallback: number): number {
  const raw = Number(req.query.get('limit'));
  return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
}
