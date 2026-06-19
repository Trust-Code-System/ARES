/**
 * CLI: re-embed stored semantic memories with the CURRENT embedder.  `npm run reembed`
 *
 * Switching embedding providers (e.g. Gemini → Voyage) leaves old rows in the
 * previous model's vector space, so similarity search mixes two incompatible
 * spaces until they're rebuilt. This reads each active semantic_memory row,
 * re-embeds its text with whatever buildEmbeddings selects now, and updates the
 * embedding in place.
 *
 * Safe: it only READs content and UPDATEs the embedding column — no deletes, no
 * content changes. Superseded rows (replaced by consolidation summaries) are
 * skipped by default since retrieval ignores them; pass `all` to include them:
 *   npm run reembed -- all
 * Optional batch size as the next arg (default 64): npm run reembed -- all 32
 */

import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { PgDb, toVectorLiteral, type Db } from '../db/client.js';
import { buildEmbeddings } from '../memory/factory.js';
import { HashEmbeddingClient, type EmbeddingClient } from '../memory/embeddings.js';

interface Row { id: string; content: string }

async function reembedAll(
  db: Db,
  embeddings: EmbeddingClient,
  expectedDim: number,
  opts: { includeSuperseded: boolean; batchSize: number },
  logger: ConsoleLogger,
): Promise<number> {
  const where = opts.includeSuperseded ? '' : 'where superseded_at is null';
  const { rows } = await db.query<Row>(
    `select id, content from semantic_memory ${where} order by created_at`,
  );
  if (rows.length === 0) {
    logger.info('No semantic memories to re-embed.');
    return 0;
  }
  logger.info(`Re-embedding ${rows.length} memories in batches of ${opts.batchSize}…`);

  let done = 0;
  for (let i = 0; i < rows.length; i += opts.batchSize) {
    const batch = rows.slice(i, i + opts.batchSize);
    const vectors = await embeddings.embed(batch.map((r) => r.content), 'document');

    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j] ?? [];
      if (vec.length !== expectedDim) {
        throw new Error(
          `Embedder returned ${vec.length} dims but the column is vector(${expectedDim}). ` +
            'Re-embedding aborted — fix ARES_EMBEDDING_* / the model before retrying.',
        );
      }
      await db.query(`update semantic_memory set embedding = $1 where id = $2`, [
        toVectorLiteral(vec),
        batch[j]!.id,
      ]);
    }
    done += batch.length;
    logger.info(`  …${done}/${rows.length}`);
  }
  return done;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');

  if (!config.databaseUrl) {
    logger.error('DATABASE_URL is not set — there is no persistent memory to re-embed.');
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const includeSuperseded = args.includes('all');
  const batchArg = args.find((a) => /^\d+$/.test(a));
  const batchSize = batchArg ? Math.max(1, Math.min(128, Number(batchArg))) : 64;

  const embeddings = buildEmbeddings(config, logger);
  if (embeddings instanceof HashEmbeddingClient) {
    logger.error(
      'Current embedder is the offline HASH embedder (no VOYAGE_API_KEY / GEMINI_API_KEY). ' +
        'Re-embedding to hash vectors would WORSEN recall — aborting. Configure a real embedder first.',
    );
    process.exitCode = 1;
    return;
  }
  logger.info(`Embedder: ${embeddings.constructor.name} · model ${config.embeddingModel} · dim ${config.embeddingDim}`);

  const db = new PgDb(config.databaseUrl);
  try {
    const n = await reembedAll(db, embeddings, config.embeddingDim, { includeSuperseded, batchSize }, logger);
    logger.info(`Done. Re-embedded ${n} memor${n === 1 ? 'y' : 'ies'} into ${embeddings.constructor.name} space.`);
  } catch (err) {
    logger.error('re-embed failed', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main();
