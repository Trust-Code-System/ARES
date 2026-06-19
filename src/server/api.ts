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
import { type FeedbackRating, type FeedbackStore, type PreferenceSource } from '../feedback/store.js';
import type { VisionExtractor } from '../llm/vision.js';
import type { VoiceProvider } from './voice.js';
import { CAPABILITY_BLUEPRINT, type CapabilityId, type RuntimeCapability } from '../agent/capabilities.js';
import { EFFORT_LEVELS } from '../agent/effort.js';
import {
  chatSchema,
  confirmationSchema,
  createTaskSchema,
  killSwitchSchema,
  parseBody,
  recordFeedbackSchema,
  recordPreferenceSchema,
  rememberSchema,
  toggleToolSchema,
  updateTaskSchema,
} from './schemas.js';
import { containsSensitiveData, redactSensitiveText } from '../security/redactor.js';

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
  /** Feedback store (ratings/corrections + preference pairs). Optional. */
  feedback?: FeedbackStore;
  scheduler?: Scheduler;
  /** Optional voice provider for the /api/voice/* endpoints (httpServer.ts). */
  voice?: VoiceProvider;
  /** Optional vision extractor for OCR on uploaded images (/api/extract). */
  vision?: VisionExtractor;
  /** Semantic store + embedder for the /api/memory/semantic browse endpoint. */
  semantic?: SemanticStore;
  embeddings?: EmbeddingClient;
  runtime?: {
    provider: 'anthropic' | 'openai' | 'gemini';
    model: string;
    fastModel: string;
    /** Selectable model options for the UI switch (`auto` + per-provider tiers). */
    modelOptions?: Array<{ id: string; label: string; detail: string }>;
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
    capabilities?: RuntimeCapability[];
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
        modelOptions: this.deps.runtime?.modelOptions ?? [],
        effortLevels: EFFORT_LEVELS,
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
        capabilities: this.deps.runtime?.capabilities ?? this.capabilityStatus(),
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
        ? await this.deps.structured.search(redactSensitiveText(q), limit(req, 50))
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

    if (method === 'GET' && path === '/api/feedback') return this.listFeedback(req);
    if (method === 'POST' && path === '/api/feedback') return this.recordFeedback(req.body);
    if (method === 'GET' && path === '/api/preferences') return this.listPreferences(req);
    if (method === 'POST' && path === '/api/preferences') return this.recordPreference(req.body);

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
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
      ...(parsed.data.history ? { history: parsed.data.history } : {}),
    });
    return ok({
      runId: result.runId,
      finalText: result.finalText,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      events: this.deps.audit.forRun(result.runId),
    });
  }

  private capabilityStatus(): RuntimeCapability[] {
    const has = (name: string): boolean => this.deps.registry.has(name);
    const runtime = this.deps.runtime;
    const connectors = runtime?.connectors ?? [];
    const persistent = runtime?.persistentMemory ?? false;

    return CAPABILITY_BLUEPRINT.map((item) => {
      const state = capabilityState(item.id, {
        has,
        persistent,
        webSearch: runtime?.webSearchEnabled ?? has('web_search'),
        voice: runtime?.voiceEnabled ?? Boolean(this.deps.voice),
        shell: runtime?.shellEnabled ?? has('run_command'),
        python: runtime?.pythonEnabled ?? has('run_python'),
        systemActions: runtime?.systemActionsEnabled ?? has('open_application'),
        github: runtime?.githubEnabled ?? has('github_search'),
        connectors,
      });
      return { id: item.id, label: item.label, strength: item.strength, ...state };
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
    const safeQuery = redactSensitiveText(q);
    const [embedding] = await this.deps.embeddings.embed([safeQuery], 'query');
    const hits = await this.deps.semantic.search(embedding ?? [], limit(req, 10));
    return ok({ hits });
  }

  private async remember(body: unknown): Promise<ApiResponse> {
    const parsed = parseBody(rememberSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    if (containsSensitiveData(parsed.data)) {
      return {
        status: 400,
        body: {
          error:
            'ARES does not store passwords, OTPs, PINs, private keys, seed phrases, CVV values, session cookies, or authentication secrets.',
        },
      };
    }
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

  private async listFeedback(req: ApiRequest): Promise<ApiResponse> {
    if (!this.deps.feedback) return ok({ feedback: [] });
    const ratingRaw = req.query.get('rating');
    const filter: { rating?: FeedbackRating; limit: number } = { limit: limit(req, 100) };
    if (ratingRaw !== null) {
      const n = Number(ratingRaw);
      if (n !== -1 && n !== 0 && n !== 1) return badRequest('rating must be -1, 0, or 1');
      filter.rating = n as FeedbackRating;
    }
    const feedback = await this.deps.feedback.list(filter);
    return ok({ feedback });
  }

  private async recordFeedback(body: unknown): Promise<ApiResponse> {
    if (!this.deps.feedback) return { status: 404, body: { error: 'feedback is not configured' } };
    const parsed = parseBody(recordFeedbackSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const input = parsed.data;
    const fb = await this.deps.feedback.record({
      rating: input.rating,
      ...(input.target ? { target: input.target } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.correction !== undefined ? { correction: input.correction } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.response !== undefined ? { response: input.response } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
    // A correction with both sides present yields a ready-made preference pair.
    let pair;
    if (input.correction && input.prompt && input.response) {
      pair = await this.deps.feedback.addPreference({
        prompt: input.prompt,
        chosen: input.correction,
        rejected: input.response,
        reason: input.note ?? 'User correction',
        source: 'correction',
      });
    }
    return ok({ feedback: fb, ...(pair ? { preference: pair } : {}) });
  }

  private async listPreferences(req: ApiRequest): Promise<ApiResponse> {
    if (!this.deps.feedback) return ok({ preferences: [] });
    const source = req.query.get('source');
    const preferences = await this.deps.feedback.listPreferences({
      ...(source ? { source: source as PreferenceSource } : {}),
      limit: limit(req, 200),
    });
    return ok({ preferences });
  }

  private async recordPreference(body: unknown): Promise<ApiResponse> {
    if (!this.deps.feedback) return { status: 404, body: { error: 'feedback is not configured' } };
    const parsed = parseBody(recordPreferenceSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const input = parsed.data;
    const preference = await this.deps.feedback.addPreference({
      prompt: input.prompt,
      chosen: input.chosen,
      rejected: input.rejected,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      source: input.source ?? 'ab_choice',
      ...(input.safetyLabel ? { safetyLabel: input.safetyLabel } : {}),
    });
    return ok({ preference });
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

interface CapabilityInputs {
  has(name: string): boolean;
  persistent: boolean;
  webSearch: boolean;
  voice: boolean;
  shell: boolean;
  python: boolean;
  systemActions: boolean;
  github: boolean;
  connectors: string[];
}

function capabilityState(
  id: CapabilityId,
  input: CapabilityInputs,
): Pick<RuntimeCapability, 'enabled' | 'detail'> {
  switch (id) {
    case 'reasoning':
      return { enabled: true, detail: 'Agent loop, model routing, tools, and verification checklist' };
    case 'coding':
      return {
        enabled: input.has('read_file') && input.has('write_file'),
        detail:
          `${input.shell ? 'shell' : 'no shell'}, ${input.github ? 'GitHub tools' : 'no GitHub tools'}, workspace file tools`,
      };
    case 'documents':
      return {
        enabled: input.has('read_pdf') && input.has('read_docx') && input.has('read_spreadsheet'),
        detail: input.has('extract_image_text') ? 'PDF, Word, spreadsheet, and image OCR' : 'PDF, Word, and spreadsheet extraction',
      };
    case 'long_context_memory':
      return {
        enabled: true,
        detail: input.persistent ? 'Chat history + persistent semantic memory' : 'Chat history + ephemeral memory',
      };
    case 'connectors_mcp':
      return {
        enabled: input.connectors.length > 0 || input.has('list_mcp_servers'),
        detail: input.connectors.length ? input.connectors.join(', ') : 'MCP management available; no active connector imported',
      };
    case 'research':
      return {
        enabled: input.webSearch && input.has('web_fetch'),
        detail: input.webSearch ? 'Search + guarded page retrieval' : 'web_search provider not configured',
      };
    case 'deep_research':
      return {
        enabled: input.has('deep_research'),
        detail: input.has('deep_research')
          ? 'Multi-source fan-out with cited report synthesis'
          : 'needs a search provider and a synthesizer',
      };
    case 'web_verification':
      return {
        enabled: input.has('web_fetch'),
        detail: input.webSearch ? 'Current search plus fetch' : 'Fetch available; search provider not configured',
      };
    case 'output_workspace':
      return {
        enabled: input.has('write_file'),
        detail: 'Workspace file output for reusable reports, code, and documents',
      };
    case 'skills':
      return {
        enabled: input.has('find_skill') && input.has('use_skill'),
        detail: input.has('find_skill') ? 'Skill search and progressive loading' : 'skill library disabled',
      };
    case 'file_engine':
      return {
        enabled: input.has('read_file') && input.has('write_file'),
        detail: 'Jailed read/write/list plus document extractors',
      };
    case 'computer_mode':
      return {
        enabled: input.systemActions,
        detail: input.systemActions ? 'Approved app and URL launch tools' : 'system actions disabled',
      };
    case 'ui_design':
      return {
        enabled: true,
        detail: 'Design mode, frontend specialist agents, and UI verification guidance',
      };
    case 'data_analysis':
      return {
        enabled: input.has('calculate') || input.python || input.has('read_spreadsheet'),
        detail: `${input.python ? 'Python runner' : 'calculator'} + spreadsheet extraction`,
      };
    case 'office_work':
      return {
        enabled: input.has('read_docx') && input.has('write_file'),
        detail: 'Reports, policies, letters, slide briefs, tables, and spreadsheet-ready output',
      };
    case 'memory':
      return {
        enabled: input.has('remember_memory') || input.persistent,
        detail: input.persistent ? 'Structured + semantic persistent memory' : 'structured in-memory facts',
      };
    case 'meeting_intelligence':
      return {
        enabled: input.has('analyze_transcript'),
        detail: input.has('analyze_transcript')
          ? 'Transcript → summary, decisions, action items, open questions'
          : 'needs a synthesizer',
      };
    case 'image_generation_boundary':
      return {
        enabled: input.has('generate_image'),
        detail: input.has('generate_image')
          ? 'Native image generation into the workspace (gated)'
          : 'Prompt/design direction; native photo generation not configured',
      };
    case 'effort_control':
      return {
        enabled: true,
        detail: 'Per-turn quick / standard / deep response depth',
      };
    case 'hallucination_control':
      return {
        enabled: true,
        detail: 'Source/date checking guidance and insufficient-evidence response mode',
      };
    case 'autonomy_permissions':
      return {
        enabled: true,
        detail: 'Confirmation gate, standing rules, kill switch, and approval queue',
      };
    case 'audit_log':
      return {
        enabled: true,
        detail: 'Run, model, tool, gate, error, and completion events',
      };
    case 'project_workspaces':
      return {
        enabled: true,
        detail: input.persistent ? 'Project memories can persist across runs' : 'Project mode active; persistence not configured',
      };
  }
}
