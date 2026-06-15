/**
 * Run a single task autonomously — i.e. with NO human at the keyboard.
 *
 *   npm run autonomous -- "summarize my unread mail and flag anything urgent"
 *   npm run autonomous -- --trigger schedule:test "draft my morning briefing"
 *
 * This is the manual entry point for the autonomous path that Phase 4's schedulers
 * and webhooks will drive automatically. It builds the same agent as the REPL but
 * routes the task through the {@link AutonomousRunner}, so the kill switch is
 * honored and the run is recorded on the activity feed. Because no prompter is
 * wired, any state-mutating tool call queues for approval rather than executing.
 */

import { argv } from 'node:process';
import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { buildLlmClient } from '../llm/factory.js';
import { createDefaultRegistry } from '../tools/index.js';
import { buildSearchProvider } from '../tools/searchFactory.js';
import { PaperBrokerProvider } from '../tools/builtin/trading.js';
import { buildMemoryBackend } from '../memory/factory.js';
import { buildSafetyBackend } from '../safety/factory.js';
import { buildAutonomyBackend } from '../autonomy/factory.js';
import { buildMcpTools } from '../mcp/factory.js';
import { Agent } from '../agent/orchestrator.js';
import { AutonomousRunner } from '../autonomy/runner.js';

const SYSTEM_PROMPT = `You are ARES, a personal autonomous assistant for a single principal user, running WITHOUT a human present.
- You cannot ask the user anything right now; make reasonable decisions and note what you would confirm.
- State-mutating tools are gated; with no human present they queue for later approval rather than executing. Plan around that — gather information and prepare actions, don't assume a mutation succeeded.
- Be concise. Produce a result the user can read later.`;

async function main(): Promise<void> {
  const args = argv.slice(2);
  let trigger = 'manual';
  const triggerIdx = args.indexOf('--trigger');
  if (triggerIdx !== -1) {
    trigger = args[triggerIdx + 1] ?? 'manual';
    args.splice(triggerIdx, 2);
  }
  const text = args.join(' ').trim();
  if (!text) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run autonomous -- [--trigger <name>] "<task text>"');
    process.exit(1);
  }

  const config = loadConfig();
  const logger = new ConsoleLogger('info');

  const { client } = buildLlmClient(config);

  const memory = buildMemoryBackend(config, client, logger);
  // No prompter: an autonomous run has no human, so the gate queues mutations.
  const safety = buildSafetyBackend(config, memory.db, logger);
  const autonomy = buildAutonomyBackend(memory.db);

  const searchProvider = buildSearchProvider(config);
  const mcp = await buildMcpTools(config, logger);
  const tradingProvider = config.trading.enabled
    ? new PaperBrokerProvider({ startingCash: config.trading.startingCash })
    : undefined;

  const agent = new Agent({
    client,
    registry: createDefaultRegistry({
      workspaceDir: config.workspaceDir,
      ...(searchProvider ? { searchProvider } : {}),
      shell: config.shell,
      python: config.python,
      systemActionsEnabled: config.systemActionsEnabled,
      ...(tradingProvider ? { tradingProvider } : {}),
      structuredStore: memory.structured,
      extraTools: mcp.tools,
    }),
    gate: safety.gate,
    memory: memory.retriever,
    memoryWriter: memory.memoryWriter,
    logger,
    audit: memory.audit,
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: config.maxIterations,
  });

  const runner = new AutonomousRunner({
    agent,
    killSwitch: autonomy.killSwitch,
    activityFeed: autonomy.activityFeed,
    logger,
  });

  logger.info('autonomous run starting', { trigger, persistent: memory.persistent });

  try {
    const result = await runner.run({ trigger, input: { text, source: 'event' } });
    process.stdout.write(`\n\x1b[1mARES (${result.status}) ›\x1b[0m ${result.finalText ?? '(no output)'}\n`);
    process.stdout.write(`\x1b[90m[activity ${result.activityId}${result.runId ? ` · run ${result.runId}` : ''}]\x1b[0m\n`);
    if (result.status === 'skipped') {
      process.stdout.write('\x1b[33mTask was skipped — the kill switch is engaged. Run `npm run control resume`.\x1b[0m\n');
    }
  } finally {
    await memory.flushMemory(); // finish background ingestion before exit
    await mcp.close();
    await memory.db?.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('autonomous run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
