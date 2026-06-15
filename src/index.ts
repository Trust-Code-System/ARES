/**
 * ARES entry point (Phase 1).
 *
 * Wires the brain together and runs it. Two modes:
 *   - one-shot:  `npm run ask -- "what time is it in Tokyo?"`
 *   - interactive REPL (no args): type messages, Ctrl-C to quit.
 *
 * This file is the composition root — the only place that constructs concrete
 * implementations. Everything downstream depends on interfaces, so swapping the
 * in-memory audit log / null memory for Postgres in Phase 2 happens only here.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv } from 'node:process';
import { loadConfig } from './config.js';
import { ConsoleLogger } from './logging/logger.js';
import { buildLlmClient } from './llm/factory.js';
import { buildVisionExtractor } from './llm/vision.js';
import { createDefaultRegistry } from './tools/index.js';
import { buildSearchProvider } from './tools/searchFactory.js';
import { buildBrokerProvider } from './tools/builtin/trading.js';
import { buildGithubClient } from './tools/builtin/github.js';
import { buildMemoryBackend } from './memory/factory.js';
import { buildSafetyBackend } from './safety/factory.js';
import { buildMcpTools } from './mcp/factory.js';
import { buildNotificationStore } from './notifications/store.js';
import { buildTaskStore } from './tasks/store.js';
import { buildToolPermissionStore } from './tools/permissions.js';
import { Agent } from './agent/orchestrator.js';
import type { ConfirmationPrompt } from './tools/confirmation.js';

const SYSTEM_PROMPT = `You are ARES, a personal autonomous assistant for a single principal user.

Operating principles:
- Be deterministic where it matters (money, scheduling, data writes); use the provided tools rather than guessing.
- You have a set of tools. Read-only tools run freely. Tools that change external state or contact the user are gated and may require the user's confirmation — if one is blocked, adapt your plan instead of retrying blindly.
- Prefer doing the work over describing it. When you have enough information, act.
- Keep final answers concise and direct.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');
  const oneShot = argv.slice(2).join(' ').trim();
  const rl = oneShot ? undefined : createInterface({ input: stdin, output: stdout });
  const confirmationPrompt: ConfirmationPrompt | undefined = rl
    ? (question) => rl.question(question)
    : undefined;

  const llm = buildLlmClient(config);
  const client = llm.client;

  // Phase 2: real memory (Postgres + pgvector) when configured, else in-memory.
  const memory = buildMemoryBackend(config, client, logger);

  // Phase 3: rule-based gate + persistent confirmation queue (shares the Db).
  const safety = buildSafetyBackend(config, memory.db, logger, confirmationPrompt);

  // Phase 5 hardening: durable notification history, tasks, and tool permissions.
  const notifications = buildNotificationStore(memory.db);
  const tasks = buildTaskStore(memory.db);
  const toolPermissions = buildToolPermissionStore(memory.db);

  const searchProvider = buildSearchProvider(config);
  if (!searchProvider) logger.warn('No TAVILY_API_KEY — web_search is disabled.');

  // Phase 3: import Gmail/Calendar/… tools from configured MCP servers. They land
  // in the registry alongside the built-ins, so they pass the gate + audit too.
  const mcp = await buildMcpTools(config, logger);

  const tradingProvider = buildBrokerProvider(config.trading);
  if (tradingProvider) logger.info('trading enabled', { broker: tradingProvider.name });

  const githubClient = buildGithubClient(config);
  if (!githubClient) logger.warn('No GITHUB_TOKEN — github_* dev tools are disabled.');

  // OCR for extract_image_text always uses Claude vision when an Anthropic key is
  // present, independent of the chosen reasoning provider.
  const visionExtractor = buildVisionExtractor({
    ...(config.anthropicApiKey ? { anthropicApiKey: config.anthropicApiKey } : {}),
    model: config.fastModel,
  });
  if (!visionExtractor) logger.warn('No ANTHROPIC_API_KEY — extract_image_text (image OCR) is disabled.');

  const registry = createDefaultRegistry({
    workspaceDir: config.workspaceDir,
    ...(searchProvider ? { searchProvider } : {}),
    shell: config.shell,
    python: config.python,
    systemActionsEnabled: config.systemActionsEnabled,
    ...(tradingProvider ? { tradingProvider } : {}),
    ...(githubClient ? { githubClient } : {}),
    structuredStore: memory.structured,
    ...(visionExtractor ? { visionExtractor } : {}),
    notificationStore: notifications,
    taskStore: tasks,
    extraTools: mcp.tools,
  });
  for (const name of await toolPermissions.disabledTools()) registry.setEnabled(name, false);

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

  logger.info('ARES online', {
    provider: llm.provider,
    model: llm.reasoningModel,
    confirmation: config.confirmationMode,
    memory: memory.persistent ? 'postgres' : 'in-memory (ephemeral)',
    workspace: config.workspaceDir,
    webSearch: searchProvider?.name ?? 'disabled',
    mcpTools: mcp.tools.length,
  });

  if (oneShot) {
    await runOnce(agent, oneShot);
    await memory.flushMemory(); // let background ingestion + audit writes finish before exit
    await mcp.close();
    await memory.db?.close();
    return;
  }
  process.once('SIGINT', () => {
    void memory
      .flushMemory()
      .finally(() => mcp.close())
      .finally(() => memory.db?.close())
      .finally(() => process.exit(0));
  });

  // Interactive REPL.
  stdout.write('\nARES interactive mode. Type a message (Ctrl-C to quit).\n');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const text = (await rl!.question('\nyou › ')).trim();
    if (!text) continue;
    await runOnce(agent, text);
  }
}

async function runOnce(agent: Agent, text: string): Promise<void> {
  const result = await agent.run({ text, source: 'user' });
  stdout.write(`\n\x1b[1mARES ›\x1b[0m ${result.finalText || '(no text response)'}\n`);
  stdout.write(
    `\x1b[90m[${result.stopReason} · ${result.iterations} step(s) · ` +
      `${result.toolCalls.length} tool call(s)]\x1b[0m\n`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\x1b[31mfatal:\x1b[0m', err instanceof Error ? err.message : err);
  process.exit(1);
});
