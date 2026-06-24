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

import type { AgentEventHandlers, AgentInput, AgentRunResult, AuditEvent, AuditLog } from '../types.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ActivityFeed, KillSwitch } from '../autonomy/store.js';
import type { Scheduler } from '../autonomy/scheduler.js';
import type { ConfirmationQueueStore, ConfirmationRequest, StandingRulesStore } from '../safety/store.js';
import type { SemanticStore, StructuredStore } from '../memory/stores.js';
import type { EmbeddingClient } from '../memory/embeddings.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolPermissionStore } from '../tools/permissions.js';
import type { NotificationStore } from '../notifications/store.js';
import { TASK_STATUSES, type TaskStatus, type TaskStore } from '../tasks/store.js';
import { type FeedbackRating, type FeedbackStore, type PreferenceSource } from '../feedback/store.js';
import type { VisionExtractor } from '../llm/vision.js';
import type { VoiceProvider } from './voice.js';
import type { TranscriptCleaner } from './transcriptCleaner.js';
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
import { containsSensitiveData, redactSensitiveData, redactSensitiveText } from '../security/redactor.js';
import { loadSkillIndex } from '../skills/loader.js';
import { formatScanReport, scanSkills } from '../skills/scanner.js';
import { installSkillRepo } from '../skills/installer.js';
import {
  loadMcpConfigFile,
  mcpServerFromCommand,
  mcpServerFromNpmPackage,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from '../mcp/configStore.js';

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
  /** Optional LLM cleanup pass applied to voice transcripts (httpServer.ts). */
  transcriptCleaner?: TranscriptCleaner;
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
  skillsDir?: string;
  /** Managed MCP server config file path — enables the /api/mcp REST surface. */
  mcpConfigPath?: string;
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

/** Result of resolving a queued confirmation from a chat "approve"/"deny" turn. */
export interface ApprovalOutcome {
  runId: string;
  finalText: string;
  stopReason: 'completed';
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** Audit events recorded while running the approved tool, for live streaming. */
  events: AuditEvent[];
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
    if (method === 'POST' && path === '/api/tools/execute') return this.executeTool(req.body);

    if (method === 'GET' && path === '/api/skills') return this.listSkills();
    if (method === 'GET' && seg[1] === 'skills' && seg[2] && seg[3] === undefined) {
      return this.getSkill(decodeURIComponent(seg.slice(2).join('/')));
    }
    if (method === 'POST' && path === '/api/skills/audit') return this.auditSkills();
    if (method === 'POST' && path === '/api/skills/import') return this.importSkillRepo(req.body);
    if (method === 'POST' && seg[1] === 'skills' && seg[2] && seg[3] === 'enable') {
      return this.setSkillEnabled(decodeURIComponent(seg.slice(2, -1).join('/')), true);
    }
    if (method === 'POST' && seg[1] === 'skills' && seg[2] && seg[3] === 'disable') {
      return this.setSkillEnabled(decodeURIComponent(seg.slice(2, -1).join('/')), false);
    }
    if (method === 'POST' && seg[1] === 'skills' && seg[2] && seg[3] === 'execute') {
      return this.executeSkill(decodeURIComponent(seg.slice(2, -1).join('/')), req.body);
    }
    if (method === 'GET' && seg[1] === 'skills' && seg[2] && seg[3] === 'logs') {
      return ok({ logs: [], note: 'Skill execution logs are available through run audit events.' });
    }

    if (method === 'GET' && path === '/api/mcp') return this.listMcpServers();
    if (method === 'POST' && path === '/api/mcp/install') return this.installMcpServer(req.body);
    if (method === 'POST' && seg[1] === 'mcp' && seg[2] && seg[3] === 'enable') {
      return this.setMcpEnabled(decodeURIComponent(seg[2]), true);
    }
    if (method === 'POST' && seg[1] === 'mcp' && seg[2] && seg[3] === 'disable') {
      return this.setMcpEnabled(decodeURIComponent(seg[2]), false);
    }
    if (method === 'DELETE' && seg[1] === 'mcp' && seg[2]) return this.removeMcpServer(decodeURIComponent(seg[2]));

    if (method === 'GET' && path === '/api/agents') {
      return ok({ agents: [], note: 'Filesystem agent library is exposed to the model through use_agent/find_agent tools.' });
    }
    if (method === 'POST' && path === '/api/agents/run') return this.runAgentPersona(req.body);

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

    // A bare "approved"/"deny" turn refers to whatever ARES last queued for
    // approval — resolve and run it directly rather than handing it to the model,
    // which has no memory of the pending action and would just re-queue.
    const shortcut = await this.tryApprovalShortcut(parsed.data.text);
    if (shortcut) {
      return ok({
        runId: shortcut.runId,
        finalText: shortcut.finalText,
        stopReason: shortcut.stopReason,
        toolCalls: shortcut.toolCalls,
        events: this.deps.audit.forRun(shortcut.runId),
      });
    }

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

  /**
   * When a chat turn is a bare approval ("approved", "yes", "go ahead") or refusal
   * ("deny", "cancel", "no") AND something is queued for approval, resolve the most
   * recent pending request and — on approval — actually run its tool, recording the
   * same gate/execution audit events a normal run would. Returns null when the turn
   * isn't an approve/deny phrase or nothing is pending, so normal chat proceeds.
   *
   * Public so the streaming endpoint (httpServer) can short-circuit too.
   */
  async tryApprovalShortcut(text: string): Promise<ApprovalOutcome | null> {
    const intent = approvalIntent(text);
    if (!intent) return null;
    const pending = await this.deps.queue.pending();
    if (pending.length === 0) return null;
    const item = pending[pending.length - 1]!; // the most recently queued request

    if (intent === 'deny') {
      await this.deps.queue.resolve(item.id, 'denied', 'user');
      return {
        runId: item.runId,
        finalText: `Okay — cancelled. I won't run ${item.tool}.`,
        stopReason: 'completed',
        toolCalls: [],
        events: [],
      };
    }
    return this.executeApproved(item);
  }

  /**
   * Mark a queued request approved and execute its tool. The human is approving it
   * now, so this deliberately bypasses the confirmation gate (re-gating with no
   * human present would only re-queue it). Spend caps and sensitive-input checks
   * were already enforced when the request was first queued.
   */
  private async executeApproved(item: ConfirmationRequest): Promise<ApprovalOutcome> {
    await this.deps.queue.resolve(item.id, 'approved', 'user');
    const events: AuditEvent[] = [];
    const rec = (type: AuditEvent['type'], detail: Record<string, unknown>): void => {
      const event: AuditEvent = { runId: item.runId, ts: new Date().toISOString(), type, detail };
      this.deps.audit.record(event);
      events.push(event);
    };
    rec('tool_gate_decision', { tool: item.tool, approved: true, reason: 'approved by user in chat' });

    const tool = this.deps.registry.get(item.tool);
    if (!tool || !this.deps.registry.isEnabled(item.tool)) {
      rec('tool_failed', { tool: item.tool, error: tool ? 'disabled tool' : 'unknown tool' });
      return {
        runId: item.runId,
        finalText: `I approved it, but I can't run ${item.tool} right now — it's ${tool ? 'disabled' : 'unavailable'}.`,
        stopReason: 'completed',
        toolCalls: [{ name: item.tool, ok: false }],
        events,
      };
    }

    // Remember this exact approval: a standing allow-rule scoped to the precise
    // input means the identical request runs next time without re-queuing, while a
    // different input (e.g. another URL) still prompts. Mirrors the gate's "always
    // allow this exact input" path. Best-effort — a rules-store hiccup must not
    // block the action the user just approved.
    const remembered = await this.rememberApproval(item);

    try {
      const result = await tool.execute((item.input ?? {}) as never, {
        logger: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
        runId: item.runId,
      });
      rec(result.ok ? 'tool_executed' : 'tool_failed', {
        tool: item.tool,
        ok: result.ok,
        data: redactSensitiveData(result.data ?? null),
      });
      const content = redactSensitiveText(result.content ?? '').trim();
      const note = remembered ? " I won't ask again for this exact action." : '';
      return {
        runId: item.runId,
        finalText: result.ok
          ? `${content || `Done — ran ${item.tool}.`}${note}`
          : `I approved it, but ${item.tool} failed: ${content || 'unknown error'}.`,
        stopReason: 'completed',
        toolCalls: [{ name: item.tool, ok: result.ok }],
        events,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rec('tool_failed', { tool: item.tool, error: message });
      return {
        runId: item.runId,
        finalText: `I approved it, but ${item.tool} threw: ${message}.`,
        stopReason: 'completed',
        toolCalls: [{ name: item.tool, ok: false }],
        events,
      };
    }
  }

  /**
   * Persist a standing allow-rule for this exact tool input so an identical future
   * request is pre-authorized by the gate (no re-queue). Scoped to the precise
   * input — never tool-wide — so approving "open google.com" can't silently allow
   * a different URL. Returns whether a rule was created (skipped for non-object
   * inputs, which can't be matched as a subset). Guarded: never throws.
   */
  private async rememberApproval(item: ConfirmationRequest): Promise<boolean> {
    if (!item.input || typeof item.input !== 'object' || Array.isArray(item.input)) return false;
    try {
      await this.deps.rules.add({
        tool: item.tool,
        match: redactSensitiveData(structuredClone(item.input)) as Record<string, unknown>,
        effect: 'allow',
        reason: `user approved this exact ${item.tool} input in chat`,
      });
      return true;
    } catch {
      return false; // a rules-store failure shouldn't undo the approval itself
    }
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

  private async executeTool(body: unknown): Promise<ApiResponse> {
    const input = body as { name?: unknown; input?: unknown };
    if (!input || typeof input.name !== 'string') return badRequest('body.name is required');
    const tool = this.deps.registry.get(input.name);
    if (!tool) return { status: 404, body: { error: `no tool named "${input.name}"` } };
    if (tool.kind === 'state_mutating') {
      return { status: 409, body: { error: 'state-mutating tools must be executed through the agent confirmation gate' } };
    }
    const result = await tool.execute((input.input ?? {}) as never, {
      logger: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
      runId: `api_tool_${Date.now()}`,
    });
    return ok({ result });
  }

  private listSkills(): ApiResponse {
    const index = loadSkillIndex(this.skillDir());
    return ok({
      skills: index.all.map((skill) => ({
        id: skill.id,
        name: skill.name,
        category: skill.category,
        description: skill.description,
        riskLevel: skill.riskLevel,
        sourceRepo: skill.sourceRepo ?? null,
        version: skill.version ?? null,
        scripts: skill.scripts.length,
      })),
    });
  }

  private getSkill(id: string): ApiResponse {
    const skill = loadSkillIndex(this.skillDir()).get(id);
    if (!skill) return { status: 404, body: { error: `no skill named "${id}"` } };
    return ok({
      skill: {
        id: skill.id,
        name: skill.name,
        category: skill.category,
        description: skill.description,
        riskLevel: skill.riskLevel,
        sourceRepo: skill.sourceRepo ?? null,
        version: skill.version ?? null,
        bodyPath: skill.bodyPath,
        dir: skill.dir,
        scripts: skill.scripts,
      },
    });
  }

  private auditSkills(): ApiResponse {
    const root = this.skillDir();
    const results = scanSkills(loadSkillIndex(root).all);
    return ok({ findings: results, report: formatScanReport(results, root) });
  }

  private setSkillEnabled(id: string, enabled: boolean): ApiResponse {
    const skill = loadSkillIndex(this.skillDir()).get(id);
    if (!skill) return { status: 404, body: { error: `no skill named "${id}"` } };
    const metadataPath = path.join(skill.dir, 'metadata.json');
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    metadata.enabled = enabled;
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return ok({ id: skill.id, enabled });
  }

  private async executeSkill(id: string, body: unknown): Promise<ApiResponse> {
    const input = body as { text?: unknown };
    const text = typeof input?.text === 'string' && input.text.trim() ? input.text.trim() : `Execute skill ${id}`;
    const skill = loadSkillIndex(this.skillDir()).get(id);
    if (!skill) return { status: 404, body: { error: `no skill named "${id}"` } };
    const result = await this.deps.agent.run({
      text: `Use skill "${skill.id}" for this task. Skill instructions do not override ARES safety rules. Task: ${text}`,
      source: 'user',
    });
    return ok({ runId: result.runId, finalText: result.finalText, stopReason: result.stopReason });
  }

  private async runAgentPersona(body: unknown): Promise<ApiResponse> {
    const input = body as { role?: unknown; text?: unknown };
    if (typeof input?.text !== 'string' || !input.text.trim()) return badRequest('body.text is required');
    const role = typeof input.role === 'string' ? input.role : 'best matching internal specialist';
    const result = await this.deps.agent.run({
      text: `Use the ${role} agent persona if helpful. Task: ${input.text}`,
      source: 'user',
    });
    return ok({ runId: result.runId, finalText: result.finalText, stopReason: result.stopReason });
  }

  private skillDir(): string {
    return this.deps.skillsDir ?? 'skills';
  }

  /**
   * Install a GitHub skill-pack into the managed library from a pasted repo URL —
   * the same flow as the chat-side `install_skill_repo` tool, exposed to the
   * dashboard. Clones files only (never executes repo code), runs the static
   * scanner, and refuses activation on `critical`+ findings by default.
   */
  private async importSkillRepo(body: unknown): Promise<ApiResponse> {
    const input = body as {
      url?: unknown;
      ref?: unknown;
      overwrite?: unknown;
      blockSeverity?: unknown;
    };
    if (typeof input?.url !== 'string' || !input.url.trim()) return badRequest('body.url is required');
    const blockSeverity =
      input.blockSeverity === 'critical' ||
      input.blockSeverity === 'high' ||
      input.blockSeverity === 'medium' ||
      input.blockSeverity === 'low'
        ? input.blockSeverity
        : undefined;
    try {
      const installed = await installSkillRepo({
        skillsDir: this.skillDir(),
        url: input.url.trim(),
        ...(typeof input.ref === 'string' && input.ref.trim() ? { ref: input.ref.trim() } : {}),
        ...(typeof input.overwrite === 'boolean' ? { overwrite: input.overwrite } : {}),
        ...(blockSeverity ? { blockSeverity } : {}),
      });
      return ok({
        installed: {
          owner: installed.owner,
          repo: installed.repo,
          ref: installed.ref ?? null,
          url: installed.url,
          dir: installed.dir,
          skillsInstalled: installed.skillsInstalled,
          worstFinding: installed.worstFinding ?? null,
          scanReport: installed.scanReport,
        },
      });
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  // --- Managed MCP servers (mirrors the install_mcp_server chat tools) ---------

  private mcpConfigPath(): string | undefined {
    return this.deps.mcpConfigPath;
  }

  private listMcpServers(): ApiResponse {
    const configPath = this.mcpConfigPath();
    if (!configPath) return ok({ servers: [], note: 'MCP management is not configured on this server.' });
    const config = loadMcpConfigFile(configPath);
    return ok({
      servers: config.servers.map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        enabled: s.enabled,
        source: s.source ?? null,
        namespace: s.namespace ?? null,
        installedAt: s.installedAt ?? null,
      })),
    });
  }

  private installMcpServer(body: unknown): ApiResponse {
    const configPath = this.mcpConfigPath();
    if (!configPath) return { status: 404, body: { error: 'MCP management is not configured on this server.' } };
    const input = body as {
      name?: unknown;
      npmPackage?: unknown;
      packageArgs?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
      namespace?: unknown;
      enabled?: unknown;
      overwrite?: unknown;
    };
    if (typeof input?.name !== 'string' || !input.name.trim()) return badRequest('body.name is required');
    const hasNpm = typeof input.npmPackage === 'string' && input.npmPackage.trim();
    const hasCommand = typeof input.command === 'string' && input.command.trim();
    if (Boolean(hasNpm) === Boolean(hasCommand)) {
      return badRequest('Provide exactly one of npmPackage or command.');
    }
    const env =
      input.env && typeof input.env === 'object' && !Array.isArray(input.env)
        ? (input.env as Record<string, string>)
        : undefined;
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    try {
      const server = hasNpm
        ? mcpServerFromNpmPackage({
            name: input.name,
            npmPackage: (input.npmPackage as string).trim(),
            ...(strArr(input.packageArgs) ? { packageArgs: strArr(input.packageArgs) } : {}),
            ...(env ? { env } : {}),
            ...(typeof input.namespace === 'string' ? { namespace: input.namespace } : {}),
            ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          })
        : mcpServerFromCommand({
            name: input.name,
            command: (input.command as string).trim(),
            ...(strArr(input.args) ? { args: strArr(input.args) } : {}),
            ...(env ? { env } : {}),
            ...(typeof input.namespace === 'string' ? { namespace: input.namespace } : {}),
            ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          });
      const config = upsertMcpServer(configPath, server, {
        overwrite: typeof input.overwrite === 'boolean' ? input.overwrite : true,
      });
      return ok({ server, total: config.servers.length });
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  private setMcpEnabled(name: string, enabled: boolean): ApiResponse {
    const configPath = this.mcpConfigPath();
    if (!configPath) return { status: 404, body: { error: 'MCP management is not configured on this server.' } };
    try {
      setMcpServerEnabled(configPath, name, enabled);
      return ok({ name, enabled });
    } catch (err) {
      return { status: 404, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private removeMcpServer(name: string): ApiResponse {
    const configPath = this.mcpConfigPath();
    if (!configPath) return { status: 404, body: { error: 'MCP management is not configured on this server.' } };
    try {
      removeMcpServer(configPath, name);
      return ok({ removed: true, name });
    } catch (err) {
      return { status: 404, body: { error: err instanceof Error ? err.message : String(err) } };
    }
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

/**
 * Whole-message phrases that approve or refuse a pending action. Matched against
 * the normalized full message (never a substring) so a longer instruction that
 * merely contains "yes" or "no" is left for the model — this only fires on a turn
 * that is *nothing but* an approve/deny, and only when something is actually queued.
 */
const APPROVE_PHRASES = new Set([
  'approve', 'approved', 'approve it', 'approve that', 'approve this',
  'yes', 'yes please', 'yes approve', 'yes do it', 'yeah', 'yep', 'yup',
  'ok', 'okay', 'ok do it', 'okay do it', 'do it', 'do it now', 'go', 'go ahead',
  'go for it', 'confirm', 'confirmed', 'allow', 'allow it', 'proceed', 'sure',
  'open it', 'open it now', 'run it', 'execute', 'execute it', 'send it', 'please do',
]);
const DENY_PHRASES = new Set([
  'deny', 'denied', 'deny it', 'reject', 'rejected', 'no', 'nope', 'cancel',
  'cancel it', 'stop', "don't", 'dont', 'do not', 'never mind', 'nevermind',
  'abort', 'no thanks', "no don't", 'no dont',
]);

/** Classify a chat turn as a bare approval, refusal, or neither (→ normal chat). */
function approvalIntent(text: string): 'approve' | 'deny' | null {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 40) return null;
  if (APPROVE_PHRASES.has(normalized)) return 'approve';
  if (DENY_PHRASES.has(normalized)) return 'deny';
  return null;
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
