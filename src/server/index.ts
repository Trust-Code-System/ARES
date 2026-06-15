/**
 * ARES API server entry point:  `npm run serve`
 *
 * Builds the same agent the REPL uses (memory, safety, tools, MCP, trading) and
 * serves it plus the dashboard data over HTTP for the Phase-5 web UI. The UI is a
 * thin client; all behaviour lives in the backends wired here.
 */

import process from 'node:process';
import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { buildLlmClient } from '../llm/factory.js';
import { buildVisionExtractor } from '../llm/vision.js';
import { createDefaultRegistry } from '../tools/index.js';
import { buildSearchProvider } from '../tools/searchFactory.js';
import { buildBrokerProvider } from '../tools/builtin/trading.js';
import { buildMemoryBackend } from '../memory/factory.js';
import { buildSafetyBackend } from '../safety/factory.js';
import { buildAutonomyBackend } from '../autonomy/factory.js';
import { buildMcpTools } from '../mcp/factory.js';
import { Agent } from '../agent/orchestrator.js';
import { ApiServer } from './httpServer.js';
import { buildVoiceProvider } from './voice.js';
import { ApiKeyAuthenticator } from './auth.js';
import { buildNotificationStore } from '../notifications/store.js';
import { buildTaskStore } from '../tasks/store.js';
import { buildToolPermissionStore } from '../tools/permissions.js';

const SYSTEM_PROMPT = `You are ARES, a personal autonomous assistant for a single principal user, answering over a web chat UI.
- Use the provided tools rather than guessing for anything factual, computational, or that touches the user's world.
- State-mutating tools are gated; if one is blocked, adapt rather than retrying blindly.
- Keep answers concise and direct.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');
  const port = Number(process.env.ARES_API_PORT ?? '3001');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ARES_API_PORT must be a port number 1-65535, got "${process.env.ARES_API_PORT}".`);
  }
  const host = process.env.ARES_API_HOST ?? '127.0.0.1';
  const allowedOrigins = (process.env.ARES_API_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Auth: enforced when ARES_API_KEY is set. Binding to a non-loopback host
  // without a key would expose an unauthenticated control plane — refuse it.
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!config.apiKey && !isLoopback) {
    throw new Error(
      `Refusing to bind ARES_API_HOST="${host}" without ARES_API_KEY — that would expose ` +
        'an unauthenticated control plane. Set ARES_API_KEY (>=16 chars) or bind to 127.0.0.1.',
    );
  }
  const authenticator = config.apiKey
    ? new ApiKeyAuthenticator({ apiKey: config.apiKey, sessionTtlMs: config.sessionTtlMs })
    : undefined;
  if (!authenticator) {
    logger.warn('No ARES_API_KEY — the HTTP API is UNAUTHENTICATED (dev mode, loopback only).');
  }

  const llm = buildLlmClient(config);
  const client = llm.client;

  const memory = buildMemoryBackend(config, client, logger);
  const safety = buildSafetyBackend(config, memory.db, logger); // no prompter: UI resolves via the queue
  const autonomy = buildAutonomyBackend(memory.db);
  const notifications = buildNotificationStore(memory.db);
  const tasks = buildTaskStore(memory.db);
  const toolPermissions = buildToolPermissionStore(memory.db);
  const mcp = await buildMcpTools(config, logger);

  const searchProvider = buildSearchProvider(config);
  const tradingProvider = buildBrokerProvider(config.trading);
  const visionExtractor = buildVisionExtractor({
    ...(config.anthropicApiKey ? { anthropicApiKey: config.anthropicApiKey } : {}),
    model: config.fastModel,
  });

  const registry = createDefaultRegistry({
    workspaceDir: config.workspaceDir,
    ...(searchProvider ? { searchProvider } : {}),
    shell: config.shell,
    python: config.python,
    systemActionsEnabled: config.systemActionsEnabled,
    ...(tradingProvider ? { tradingProvider } : {}),
    structuredStore: memory.structured,
    ...(visionExtractor ? { visionExtractor } : {}),
    notificationStore: notifications,
    taskStore: tasks,
    extraTools: mcp.tools,
  });

  // Apply persisted tool-permission overrides so a deliberately disabled tool
  // stays disabled across restarts.
  for (const name of await toolPermissions.disabledTools()) {
    if (registry.setEnabled(name, false)) logger.info('tool disabled by persisted permission', { tool: name });
  }

  const agent = new Agent({
    client,
    registry,
    gate: safety.gate,
    memory: memory.retriever,
    memoryWriter: memory.memoryWriter,
    logger,
    audit: memory.audit,
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: config.maxIterations,
  });

  const voice = buildVoiceProvider();

  const server = new ApiServer({
    deps: {
      agent,
      audit: memory.audit,
      activityFeed: autonomy.activityFeed,
      killSwitch: autonomy.killSwitch,
      rules: safety.rules,
      queue: safety.queue,
      structured: memory.structured,
      semantic: memory.semantic,
      embeddings: memory.embeddings,
      notifications,
      tasks,
      toolPermissions,
      registry,
      ...(voice ? { voice } : {}),
      runtime: {
        provider: llm.provider,
        model: llm.reasoningModel,
        fastModel: llm.fastModel,
        voiceEnabled: Boolean(voice),
        voiceInputProvider: voice?.sttProvider,
        voiceOutputProvider: voice?.ttsProvider,
        persistentMemory: memory.persistent,
        webSearchEnabled: Boolean(searchProvider),
        shellEnabled: config.shell.enabled,
        pythonEnabled: config.python.enabled,
        systemActionsEnabled: config.systemActionsEnabled,
        tradingEnabled: config.trading.enabled,
        connectors: config.mcpServers.map((server) => server.name),
      },
    },
    port,
    host,
    allowedOrigins,
    logger,
    ...(authenticator ? { authenticator } : {}),
  });

  await server.start();
  logger.info('ARES API online', {
    host,
    port,
    provider: llm.provider,
    model: llm.reasoningModel,
    memory: memory.persistent ? 'postgres' : 'in-memory',
    auth: authenticator ? 'api-key + sessions' : 'disabled (dev)',
  });

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  await server.stop();
  await memory.flushMemory();
  await mcp.close();
  await memory.db?.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('server failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
