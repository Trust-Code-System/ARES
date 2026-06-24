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
import { buildModelRouter } from '../llm/router.js';
import { buildVisionExtractor } from '../llm/vision.js';
import { buildSynthesizer } from '../llm/synthesize.js';
import { buildImageGenerator } from '../llm/imageGen.js';
import { createDefaultRegistry } from '../tools/index.js';
import { SKILLS_PROMPT_NOTE } from '../skills/index.js';
import { AGENTS_PROMPT_NOTE } from '../agents/index.js';
import { buildSearchProvider } from '../tools/searchFactory.js';
import { buildBrokerProvider } from '../tools/builtin/trading.js';
import { buildGithubClient } from '../tools/builtin/github.js';
import { buildMemoryBackend } from '../memory/factory.js';
import { buildSafetyBackend } from '../safety/factory.js';
import { buildAutonomyBackend } from '../autonomy/factory.js';
import { buildMcpTools } from '../mcp/factory.js';
import { MCP_MANAGEMENT_PROMPT_NOTE } from '../mcp/tools.js';
import { Agent } from '../agent/orchestrator.js';
import { ApiServer } from './httpServer.js';
import { buildVoiceProvider } from './voice.js';
import { memoryVocabularySource } from './voiceVocabulary.js';
import { buildTranscriptCleaner } from './transcriptCleaner.js';
import { ApiKeyAuthenticator } from './auth.js';
import { buildNotificationStore } from '../notifications/store.js';
import { buildTaskStore } from '../tasks/store.js';
import { buildFeedbackStore } from '../feedback/store.js';
import { buildPreferenceSeeder } from '../feedback/actionRanking.js';
import { createPlaywrightController } from '../tools/builtin/playwrightController.js';
import { buildEmailSender } from '../tools/emailSender.js';
import { buildToolPermissionStore } from '../tools/permissions.js';
import { ARES_CAPABILITY_PROMPT } from '../agent/capabilities.js';

const SYSTEM_PROMPT = `You are ARES, a personal autonomous assistant for a single principal user, answering over a web chat UI.
- Use the provided tools rather than guessing for anything factual, computational, or that touches the user's world.
- State-mutating tools are gated; if one is blocked, adapt rather than retrying blindly.
- Keep answers concise and direct.`;

function buildSystemPrompt(config: ReturnType<typeof loadConfig>): string {
  const notes: string[] = [];
  if (config.skillsDir) notes.push(`- ${SKILLS_PROMPT_NOTE}`);
  if (config.agentsDir) notes.push(`- ${AGENTS_PROMPT_NOTE}`);
  notes.push(`- ${MCP_MANAGEMENT_PROMPT_NOTE}`);
  return `${SYSTEM_PROMPT}\n\n${ARES_CAPABILITY_PROMPT}\n${notes.join('\n')}`;
}

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
  // Multi-provider router: lets a chat turn switch provider/tier (the HUD model
  // switch) and powers `Auto`'s per-question tier selection. Built from whichever
  // providers have keys; the configured provider leads its fallback order.
  const router = buildModelRouter(config, logger);

  const memory = buildMemoryBackend(config, client, logger);
  const safety = buildSafetyBackend(config, memory.db, logger); // no prompter: UI resolves via the queue
  const autonomy = buildAutonomyBackend(memory.db);
  const notifications = buildNotificationStore(memory.db);
  const tasks = buildTaskStore(memory.db);
  const feedback = buildFeedbackStore(memory.db);
  const toolPermissions = buildToolPermissionStore(memory.db);
  const mcp = await buildMcpTools(config, logger);

  const searchProvider = buildSearchProvider(config);
  const tradingProvider = buildBrokerProvider(config.trading);
  const githubClient = buildGithubClient(config);
  const visionExtractor = buildVisionExtractor({
    ...(config.anthropicApiKey ? { anthropicApiKey: config.anthropicApiKey } : {}),
    model: config.fastModel,
  });

  const synthesizer = buildSynthesizer(client);
  const imageGenerator = buildImageGenerator();

  const browser = config.browser.enabled
    ? createPlaywrightController({ headless: config.browser.headless, timeoutMs: config.browser.timeoutMs })
    : undefined;

  const emailSender = buildEmailSender(config.email);

  const registry = createDefaultRegistry({
    workspaceDir: config.workspaceDir,
    ...(searchProvider ? { searchProvider } : {}),
    synthesizer,
    ...(imageGenerator ? { imageGenerator } : {}),
    shell: config.shell,
    python: config.python,
    systemActionsEnabled: config.systemActionsEnabled,
    remotionEnabled: config.remotionEnabled,
    ...(tradingProvider ? { tradingProvider } : {}),
    ...(githubClient ? { githubClient } : {}),
    structuredStore: memory.structured,
    ...(visionExtractor ? { visionExtractor } : {}),
    notificationStore: notifications,
    taskStore: tasks,
    feedbackStore: feedback,
    ...(browser ? { browserController: browser, browserTimeoutMs: config.browser.timeoutMs } : {}),
    ...(emailSender ? { emailSender } : {}),
    mcpConfigPath: config.mcpConfigPath,
    ...(config.skillsDir ? { skills: { dir: config.skillsDir } } : {}),
    ...(config.agentsDir ? { agents: { dir: config.agentsDir } } : {}),
    extraTools: mcp.tools,
  });

  // Apply persisted tool-permission overrides so a deliberately disabled tool
  // stays disabled across restarts.
  for (const name of await toolPermissions.disabledTools()) {
    if (registry.setEnabled(name, false)) logger.info('tool disabled by persisted permission', { tool: name });
  }

  const agent = new Agent({
    client,
    ...(router ? { router } : {}),
    registry,
    gate: safety.gate,
    memory: memory.retriever,
    memoryWriter: memory.memoryWriter,
    logger,
    audit: memory.audit,
    systemPrompt: buildSystemPrompt(config),
    maxIterations: config.maxIterations,
    enableFastChat: config.enableFastChat,
    preferenceSeeder: buildPreferenceSeeder(feedback),
  });

  // Bias speech-to-text toward the user's own world: connector names (static) and
  // the people/projects in memory (dynamic, cached). Helps STT spell personal
  // proper nouns it could never guess.
  const voice = buildVoiceProvider(process.env, {
    dynamicVocabulary: memoryVocabularySource(memory.structured),
    extraVocabulary: config.mcpServers.map((s) => s.name),
  });
  // Opt-in LLM cleanup of voice transcripts (fixes misheard product/brand names
  // via the fast model). Off unless ARES_VOICE_CLEANUP is truthy and voice is on.
  const voiceCleanupEnabled = ['true', '1', 'on', 'yes'].includes(
    (process.env.ARES_VOICE_CLEANUP ?? '').toLowerCase(),
  );
  const transcriptCleaner = voice && voiceCleanupEnabled ? buildTranscriptCleaner(synthesizer) : undefined;

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
      feedback,
      toolPermissions,
      registry,
      ...(config.skillsDir ? { skillsDir: config.skillsDir } : {}),
      ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {}),
      ...(voice ? { voice } : {}),
      ...(transcriptCleaner ? { transcriptCleaner } : {}),
      ...(visionExtractor ? { vision: visionExtractor } : {}),
      runtime: {
        provider: llm.provider,
        model: llm.reasoningModel,
        fastModel: llm.fastModel,
        ...(router ? { modelOptions: router.modelOptions() } : {}),
        voiceEnabled: Boolean(voice),
        voiceInputProvider: voice?.sttProvider,
        voiceOutputProvider: voice?.ttsProvider,
        persistentMemory: memory.persistent,
        webSearchEnabled: Boolean(searchProvider),
        shellEnabled: config.shell.enabled,
        pythonEnabled: config.python.enabled,
        systemActionsEnabled: config.systemActionsEnabled,
        tradingEnabled: config.trading.enabled,
        githubEnabled: Boolean(githubClient),
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
  await browser?.close();
  await mcp.close();
  await memory.db?.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('server failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
