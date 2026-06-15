/**
 * The autonomy daemon — the long-running process that wakes ARES on a clock.
 *
 *   npm run scheduler                 # start the daemon; Ctrl-C to stop
 *   npm run scheduler -- --once morning-briefing   # fire one job immediately and exit
 *
 * It builds the same agent as the REPL, wraps it in the AutonomousRunner (so the
 * kill switch and activity feed apply to every firing), and registers the Phase-4
 * jobs on the scheduler (BullMQ when REDIS_URL is set, in-memory otherwise).
 *
 * Jobs registered today:
 *   - morning-briefing  — 06:00 daily: calendar + mail summary + overnight news,
 *                         delivered via notify (see briefingJobs.ts).
 *   - inbox-scan        — hourly: surface anything urgent/actionable in the inbox.
 *   - nightly-consolidate — memory consolidation maintenance (only with a database).
 *
 * State-mutating tool calls inside any job still route through the gate; with no
 * human present they queue for approval rather than executing — except notify,
 * which the daemon pre-authorizes so the briefing can reach the principal.
 */

import process from 'node:process';
import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { buildLlmClient } from '../llm/factory.js';
import { createDefaultRegistry } from '../tools/index.js';
import { buildSearchProvider } from '../tools/searchFactory.js';
import { PaperBrokerProvider } from '../tools/builtin/trading.js';
import { buildGithubClient } from '../tools/builtin/github.js';
import { buildMemoryBackend, buildEmbeddings } from '../memory/factory.js';
import { buildSafetyBackend } from '../safety/factory.js';
import { buildAutonomyBackend, buildScheduler } from '../autonomy/factory.js';
import { buildMcpTools } from '../mcp/factory.js';
import { Agent } from '../agent/orchestrator.js';
import { AutonomousRunner } from '../autonomy/runner.js';
import { maintenanceJob } from '../autonomy/jobs.js';
import { morningBriefingJob, inboxScanJob } from '../autonomy/briefingJobs.js';
import { WebhookServer } from '../autonomy/webhooks.js';
import { consolidateMemory } from '../memory/consolidation.js';
import type { StandingRulesStore } from '../safety/store.js';
import type { Logger } from '../types.js';

const CONSOLIDATE_CRON = '30 3 * * *'; // 03:30 local, nightly

const SYSTEM_PROMPT = `You are ARES, running autonomously on a schedule with no human present.
- You cannot ask the user anything right now. Make reasonable decisions; note what you would confirm.
- State-mutating tools queue for approval rather than executing. Gather and prepare; don't assume a mutation happened.
- Be brief. Produce a result the user can read later.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let once: string | undefined;
  const onceIdx = args.indexOf('--once');
  if (onceIdx !== -1) once = args[onceIdx + 1];

  const config = loadConfig();
  const logger = new ConsoleLogger('info');

  const { client } = buildLlmClient(config);

  const memory = buildMemoryBackend(config, client, logger);
  const safety = buildSafetyBackend(config, memory.db, logger); // no prompter: autonomous
  const autonomy = buildAutonomyBackend(memory.db);

  const searchProvider = buildSearchProvider(config);
  const mcp = await buildMcpTools(config, logger);
  const tradingProvider = config.trading.enabled
    ? new PaperBrokerProvider({ startingCash: config.trading.startingCash })
    : undefined;
  const githubClient = buildGithubClient(config);

  const agent = new Agent({
    client,
    registry: createDefaultRegistry({
      workspaceDir: config.workspaceDir,
      ...(searchProvider ? { searchProvider } : {}),
      shell: config.shell,
      python: config.python,
      systemActionsEnabled: config.systemActionsEnabled,
      ...(tradingProvider ? { tradingProvider } : {}),
      ...(githubClient ? { githubClient } : {}),
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

  // The briefing/inbox jobs deliver via notify, which is gated. With no human at
  // the daemon, pre-authorize notify so these jobs can actually reach the
  // principal (notifying you about your own day is inherently safe).
  await ensureStandingAllow(safety.rules, 'notify', logger);

  const scheduler = buildScheduler(config, logger);

  scheduler.register(morningBriefingJob(runner));
  scheduler.register(inboxScanJob(runner));

  // Memory consolidation only makes sense against a real database.
  if (memory.db) {
    const db = memory.db;
    scheduler.register(
      maintenanceJob({
        name: 'nightly-consolidate',
        cron: CONSOLIDATE_CRON,
        run: async () => {
          const report = await consolidateMemory({
            db,
            embeddings: buildEmbeddings(config, logger),
            client,
            logger,
          });
          logger.info('nightly consolidation complete', { ...report });
        },
      }),
    );
  }

  // --once: fire one job and exit (manual smoke test of a scheduled job).
  if (once) {
    try {
      await scheduler.start();
      logger.info('firing job once', { job: once });
      await scheduler.trigger(once);
    } finally {
      await scheduler.stop();
      await memory.flushMemory();
      await mcp.close();
      await memory.db?.close();
    }
    return;
  }

  await scheduler.start();

  // Optional webhook trigger layer: external events wake the agent. Only started
  // when a secret is configured (the server refuses to run unauthenticated).
  let webhooks: WebhookServer | undefined;
  if (config.webhookSecret) {
    webhooks = new WebhookServer({
      runner,
      secret: config.webhookSecret,
      port: config.webhookPort,
      logger,
    });
    await webhooks.start();
  } else {
    logger.info('webhooks disabled (set ARES_WEBHOOK_SECRET to enable)');
  }

  logger.info('autonomy daemon online', {
    jobs: scheduler.jobs().map((j) => `${j.name}@${j.cron}`),
    scheduler: config.redisUrl ? 'bullmq' : 'in-memory',
    killSwitch: autonomy.killSwitch.constructor.name,
    webhooks: webhooks ? `:${config.webhookPort}` : 'off',
  });

  // Run until interrupted, then shut down cleanly.
  await new Promise<void>((resolve) => {
    const shutdown = (sig: string) => {
      logger.info('shutting down autonomy daemon', { signal: sig });
      resolve();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });

  await webhooks?.stop();
  await scheduler.stop();
  await memory.flushMemory();
  await mcp.close();
  await memory.db?.close();
}

/** Idempotently ensure a standing allow-rule exists for a tool. */
async function ensureStandingAllow(rules: StandingRulesStore, tool: string, logger: Logger): Promise<void> {
  const existing = (await rules.list()).find((r) => r.tool === tool && r.effect === 'allow' && r.enabled);
  if (existing) return;
  await rules.add({ tool, effect: 'allow', reason: `autonomous jobs may call ${tool} to reach the principal` });
  logger.info('seeded standing allow-rule', { tool });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('scheduler failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
