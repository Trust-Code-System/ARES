/** Loads and validates environment configuration. Fails fast on missing secrets. */

import 'dotenv/config';
import path from 'node:path';
import type { ConfirmationMode } from './tools/confirmation.js';
import type { ToolKind } from './types.js';
import { DEFAULT_COST_FIELDS, DEFAULT_TRADE_MARKERS, type SpendConfig } from './safety/caps.js';
import { DEFAULT_SHELL_ALLOWLIST } from './tools/builtin/shell.js';
import type { BrokerConfig } from './tools/builtin/trading.js';
import { activeMcpServers } from './mcp/configStore.js';

/** Sandboxed shell tool config. Disabled by default (high-risk). */
export interface ShellConfig {
  enabled: boolean;
  allowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PythonConfig {
  enabled: boolean;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** A stdio MCP server to connect to at startup and import tools from. */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Tool-name prefix; defaults to `name`. */
  namespace?: string;
  /** Per-remote-tool-name kind overrides for the classifier. */
  classifyOverrides?: Record<string, ToolKind>;
}

export interface Config {
  llmProvider: 'anthropic' | 'openai' | 'gemini';
  anthropicApiKey?: string;
  reasoningModel: string;
  fastModel: string;
  openaiApiKey?: string;
  openaiReasoningModel: string;
  openaiFastModel: string;
  openaiBaseUrl?: string;
  geminiApiKey?: string;
  geminiReasoningModel: string;
  geminiFastModel: string;
  maxIterations: number;
  /** Route casual small talk to the fast model (no tools/memory). Default on. */
  enableFastChat: boolean;
  confirmationMode: ConfirmationMode;
  // --- API auth (Phase 5 hardening) ---
  /** Shared API key for the HTTP control plane. Absent → auth disabled (dev only). */
  apiKey?: string;
  /** Session token lifetime in ms (login exchanges the key for a session). */
  sessionTtlMs: number;
  // --- Phase 2: memory ---
  /** Postgres connection string (Supabase). Absent → in-memory fallback. */
  databaseUrl?: string;
  /** Voyage AI key for embeddings. Absent → offline hash embedder (dev only). */
  voyageApiKey?: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Which embedding backend to use: auto (Voyage→Gemini→hash), voyage, or gemini. */
  embeddingProvider: 'auto' | 'voyage' | 'gemini';
  /** Gemini embedding model (used when the Gemini embedder is selected). */
  geminiEmbeddingModel: string;
  // --- Phase 3: tools ---
  /** Absolute path to the sandbox the file tools are jailed to. */
  workspaceDir: string;
  /** Tavily key for web_search. Absent → web_search is not registered. */
  tavilyApiKey?: string;
  searchProvider: 'auto' | 'google' | 'tavily';
  /** GitHub token for the dev tools. Absent → the github_* tools are not registered. */
  githubToken?: string;
  /** GitHub REST API base URL (override for GitHub Enterprise). */
  githubApiBaseUrl?: string;
  // --- Phase 4: autonomy ---
  /** Redis connection string for the BullMQ scheduler. Absent → in-memory scheduler. */
  redisUrl?: string;
  /** MCP servers (Gmail/Calendar/…) to connect to and import tools from. */
  mcpServers: McpServerConfig[];
  /** Managed MCP server config file used by the install/list/enable tools. */
  mcpConfigPath: string;
  /** Shared secret for the webhook trigger endpoint. Absent → webhooks disabled. */
  webhookSecret?: string;
  /** Port for the webhook server (daemon only). */
  webhookPort: number;
  /** Hard spend/trade caps enforced by the gate. */
  spend: SpendConfig;
  /** Sandboxed shell tool (off unless ARES_SHELL_ENABLED=true). */
  shell: ShellConfig;
  python: PythonConfig;
  systemActionsEnabled: boolean;
  /** Remotion video scaffolder (off unless ARES_REMOTION_ENABLED=true). */
  remotionEnabled: boolean;
  /** Trading tools (off unless ARES_TRADING_ENABLED=true) + broker selection. */
  trading: BrokerConfig;
  /**
   * Absolute path to the vendored expert skill library. Empty string when the
   * library is disabled (ARES_SKILLS_ENABLED=false) — find_skill/use_skill are
   * then not registered.
   */
  skillsDir: string;
  /**
   * Absolute path to the specialist-agent (persona) library. Empty string when
   * disabled (ARES_AGENTS_ENABLED=false) — find_agent/use_agent/agent_route are
   * then not registered.
   */
  agentsDir: string;
}

export function loadConfig(): Config {
  const llmProvider = process.env.ARES_LLM_PROVIDER ?? 'anthropic';
  if (!['anthropic', 'openai', 'gemini'].includes(llmProvider)) {
    throw new Error(`ARES_LLM_PROVIDER must be anthropic|openai|gemini, got "${llmProvider}".`);
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (llmProvider === 'anthropic' && !anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.',
    );
  }
  if (llmProvider === 'openai' && !openaiApiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to .env or select ARES_LLM_PROVIDER=anthropic.',
    );
  }
  if (llmProvider === 'gemini' && !geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to .env or select another ARES_LLM_PROVIDER.',
    );
  }

  const mode = (process.env.ARES_CONFIRMATION_MODE ?? 'prompt') as ConfirmationMode;
  if (!['auto', 'deny', 'prompt'].includes(mode)) {
    throw new Error(`ARES_CONFIRMATION_MODE must be auto|deny|prompt, got "${mode}".`);
  }

  const maxIterations = Number(process.env.ARES_MAX_ITERATIONS ?? '12');
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) {
    throw new Error(
      `ARES_MAX_ITERATIONS must be an integer from 1 to 100, got "${process.env.ARES_MAX_ITERATIONS}".`,
    );
  }

  const embeddingDim = Number(process.env.ARES_EMBEDDING_DIM ?? '1024');
  if (!Number.isSafeInteger(embeddingDim) || embeddingDim < 1) {
    throw new Error(
      `ARES_EMBEDDING_DIM must be a positive integer, got "${process.env.ARES_EMBEDDING_DIM}".`,
    );
  }

  const webhookPort = Number(process.env.ARES_WEBHOOK_PORT ?? '8787');
  if (!Number.isSafeInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
    throw new Error(
      `ARES_WEBHOOK_PORT must be a port number 1-65535, got "${process.env.ARES_WEBHOOK_PORT}".`,
    );
  }

  const searchProvider = process.env.ARES_SEARCH_PROVIDER ?? 'auto';
  if (!['auto', 'google', 'tavily'].includes(searchProvider)) {
    throw new Error(`ARES_SEARCH_PROVIDER must be auto|google|tavily, got "${searchProvider}".`);
  }

  const embeddingProvider = process.env.ARES_EMBEDDING_PROVIDER ?? 'auto';
  if (!['auto', 'voyage', 'gemini'].includes(embeddingProvider)) {
    throw new Error(`ARES_EMBEDDING_PROVIDER must be auto|voyage|gemini, got "${embeddingProvider}".`);
  }

  const sessionTtlHours = Number(process.env.ARES_SESSION_TTL_HOURS ?? '12');
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0 || sessionTtlHours > 720) {
    throw new Error(
      `ARES_SESSION_TTL_HOURS must be a number in (0, 720], got "${process.env.ARES_SESSION_TTL_HOURS}".`,
    );
  }
  const apiKey = process.env.ARES_API_KEY || undefined;
  if (apiKey !== undefined && apiKey.length < 16) {
    throw new Error('ARES_API_KEY must be at least 16 characters. Generate one with: openssl rand -base64 32');
  }

  return {
    llmProvider: llmProvider as Config['llmProvider'],
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    reasoningModel: process.env.ARES_REASONING_MODEL ?? 'claude-opus-4-8',
    fastModel: process.env.ARES_FAST_MODEL ?? 'claude-sonnet-4-6',
    ...(openaiApiKey ? { openaiApiKey } : {}),
    openaiReasoningModel: process.env.ARES_OPENAI_REASONING_MODEL ?? 'gpt-5.5',
    openaiFastModel: process.env.ARES_OPENAI_FAST_MODEL ?? 'gpt-5.4-mini',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    ...(geminiApiKey ? { geminiApiKey } : {}),
    geminiReasoningModel: process.env.ARES_GEMINI_REASONING_MODEL ?? 'gemini-3.5-flash',
    geminiFastModel: process.env.ARES_GEMINI_FAST_MODEL ?? 'gemini-3.1-flash-lite',
    maxIterations,
    enableFastChat: !['false', '0', 'off', 'no'].includes((process.env.ARES_FAST_CHAT ?? '').toLowerCase()),
    confirmationMode: mode,
    ...(apiKey ? { apiKey } : {}),
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    databaseUrl: process.env.DATABASE_URL || undefined,
    voyageApiKey: process.env.VOYAGE_API_KEY || undefined,
    embeddingModel: process.env.ARES_EMBEDDING_MODEL ?? 'voyage-3.5',
    embeddingDim,
    embeddingProvider: embeddingProvider as Config['embeddingProvider'],
    geminiEmbeddingModel: process.env.ARES_GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001',
    workspaceDir: path.resolve(process.env.ARES_WORKSPACE_DIR ?? './workspace'),
    tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
    searchProvider: searchProvider as Config['searchProvider'],
    githubToken: process.env.GITHUB_TOKEN || undefined,
    githubApiBaseUrl: process.env.GITHUB_API_URL || undefined,
    redisUrl: process.env.REDIS_URL || undefined,
    mcpConfigPath: parseMcpConfigPath(),
    mcpServers: parseAllMcpServers(),
    webhookSecret: process.env.ARES_WEBHOOK_SECRET || undefined,
    webhookPort,
    spend: parseSpendConfig(),
    shell: parseShellConfig(),
    python: parsePythonConfig(),
    systemActionsEnabled: process.env.ARES_SYSTEM_ACTIONS_ENABLED === 'true',
    remotionEnabled: process.env.ARES_REMOTION_ENABLED === 'true',
    trading: parseTradingConfig(),
    skillsDir: parseSkillsDir(),
    agentsDir: parseAgentsDir(),
  };
}

/**
 * Resolve the specialist-agent library directory. Enabled by default; set
 * ARES_AGENTS_ENABLED=false to turn the find_agent/use_agent/agent_route tools
 * off (returns an empty string, treated as "not configured").
 */
export function parseAgentsDir(): string {
  if (['false', '0', 'off', 'no'].includes((process.env.ARES_AGENTS_ENABLED ?? '').toLowerCase())) {
    return '';
  }
  return path.resolve(process.env.ARES_AGENTS_DIR ?? './agents');
}

/**
 * Resolve the expert skill library directory. Enabled by default; set
 * ARES_SKILLS_ENABLED=false to turn the find_skill/use_skill tools off (returns
 * an empty string, which the composition roots treat as "not configured").
 */
export function parseSkillsDir(): string {
  if (['false', '0', 'off', 'no'].includes((process.env.ARES_SKILLS_ENABLED ?? '').toLowerCase())) {
    return '';
  }
  return path.resolve(process.env.ARES_SKILLS_DIR ?? './skills');
}

export function parseMcpConfigPath(): string {
  return path.resolve(process.env.ARES_MCP_CONFIG_PATH ?? './mcp.servers.json');
}

export function parsePythonConfig(): PythonConfig {
  const timeoutMs = Number(process.env.ARES_PYTHON_TIMEOUT_MS ?? '15000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error(`ARES_PYTHON_TIMEOUT_MS must be an integer >= 100, got "${process.env.ARES_PYTHON_TIMEOUT_MS}".`);
  }
  return {
    enabled: process.env.ARES_PYTHON_ENABLED === 'true',
    command: process.env.ARES_PYTHON_COMMAND || (process.platform === 'win32' ? 'python' : 'python3'),
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  };
}

/** Parse the trading/broker config. Trading is off unless explicitly enabled. */
export function parseTradingConfig(): BrokerConfig {
  const broker = process.env.ARES_BROKER ?? 'paper';
  if (broker !== 'paper' && broker !== 'alpaca') {
    throw new Error(`ARES_BROKER must be paper|alpaca, got "${broker}".`);
  }
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL;
  return {
    enabled: process.env.ARES_TRADING_ENABLED === 'true',
    broker,
    startingCash: Number(process.env.ARES_TRADING_PAPER_CASH ?? '100000'),
    ...(keyId && secretKey
      ? { alpaca: { keyId, secretKey, ...(baseUrl ? { baseUrl } : {}) } }
      : {}),
  };
}

/** Parse the sandboxed shell tool config from env. Disabled unless explicitly on. */
export function parseShellConfig(): ShellConfig {
  const allowlistRaw = process.env.ARES_SHELL_ALLOWLIST;
  const allowlist = allowlistRaw
    ? allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SHELL_ALLOWLIST;
  const timeoutMs = Number(process.env.ARES_SHELL_TIMEOUT_MS ?? '10000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error(`ARES_SHELL_TIMEOUT_MS must be an integer >= 100, got "${process.env.ARES_SHELL_TIMEOUT_MS}".`);
  }
  return {
    enabled: process.env.ARES_SHELL_ENABLED === 'true',
    allowlist,
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  };
}

/** Parse the optional spend/trade caps from env. Unset limits are not enforced. */
export function parseSpendConfig(): SpendConfig {
  const num = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number, got "${raw}".`);
    return v;
  };
  const windowHours = num('ARES_SPEND_ROLLING_WINDOW_HOURS') ?? 24;
  let costFields = DEFAULT_COST_FIELDS;
  if (process.env.ARES_SPEND_COST_FIELDS) {
    try {
      costFields = { ...DEFAULT_COST_FIELDS, ...(JSON.parse(process.env.ARES_SPEND_COST_FIELDS) as Record<string, string>) };
    } catch (err) {
      throw new Error(`ARES_SPEND_COST_FIELDS must be valid JSON: ${(err as Error).message}`);
    }
  }
  return {
    ...(num('ARES_SPEND_PER_ACTION_LIMIT') !== undefined ? { perActionLimit: num('ARES_SPEND_PER_ACTION_LIMIT') } : {}),
    ...(num('ARES_SPEND_ROLLING_LIMIT') !== undefined ? { rollingLimit: num('ARES_SPEND_ROLLING_LIMIT') } : {}),
    rollingWindowMs: windowHours * 60 * 60 * 1000,
    ...(num('ARES_TRADE_NOTIONAL_CAP') !== undefined ? { tradeNotionalCap: num('ARES_TRADE_NOTIONAL_CAP') } : {}),
    costFields,
    tradeToolMarkers: DEFAULT_TRADE_MARKERS,
  };
}

/** Parse the ARES_MCP_SERVERS env var: a JSON array of {@link McpServerConfig}. */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ARES_MCP_SERVERS must be valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('ARES_MCP_SERVERS must be a JSON array of server configs.');
  }
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`ARES_MCP_SERVERS[${i}] must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || typeof e.command !== 'string') {
      throw new Error(`ARES_MCP_SERVERS[${i}] requires string "name" and "command".`);
    }
    return {
      name: e.name,
      command: e.command,
      ...(Array.isArray(e.args) ? { args: e.args.map(String) } : {}),
      ...(e.env && typeof e.env === 'object' ? { env: e.env as Record<string, string> } : {}),
      ...(typeof e.namespace === 'string' ? { namespace: e.namespace } : {}),
      ...(e.classifyOverrides && typeof e.classifyOverrides === 'object'
        ? { classifyOverrides: e.classifyOverrides as Record<string, ToolKind> }
        : {}),
    };
  });
}

export function parseAllMcpServers(): McpServerConfig[] {
  const envServers = parseMcpServers(process.env.ARES_MCP_SERVERS);
  const managedServers = activeMcpServers(parseMcpConfigPath());
  return [...managedServers, ...envServers];
}
