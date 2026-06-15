/**
 * CLI entry for the nightly consolidation job:  `npm run consolidate`
 *
 * Phase 4 will schedule this on BullMQ; for now it's run by hand or by an
 * external cron. Requires a database — there is nothing to consolidate in the
 * in-memory fallback.
 */

import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { buildLlmClient } from '../llm/factory.js';
import { PgDb } from '../db/client.js';
import { buildEmbeddings } from '../memory/factory.js';
import { consolidateMemory } from '../memory/consolidation.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');

  if (!config.databaseUrl) {
    logger.error('DATABASE_URL is not set — consolidation requires Postgres. Nothing to do.');
    process.exitCode = 1;
    return;
  }

  const db = new PgDb(config.databaseUrl);
  const { client } = buildLlmClient(config);

  try {
    const report = await consolidateMemory({
      db,
      embeddings: buildEmbeddings(config, logger),
      client,
      logger,
    });
    logger.info('consolidation complete', { ...report });
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('consolidation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
