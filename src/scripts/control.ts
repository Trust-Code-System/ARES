/**
 * Autonomy control CLI — the human's hand on the kill switch.
 *
 *   npm run control               # show kill-switch state + recent activity
 *   npm run control status
 *   npm run control stop [reason]  # engage: pause ALL autonomous activity
 *   npm run control resume         # disengage: allow autonomous activity again
 *   npm run control feed [n]       # show the last n activity records (default 20)
 *
 * The kill switch is durable only with a database: engaging it here writes the
 * shared `kill_switch` row that the running agent's autonomous runner polls. With
 * no DATABASE_URL the switch is in-memory and per-process, so this CLI can't reach
 * a separately-running agent — it warns and does nothing useful.
 */

import { argv } from 'node:process';
import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { PgDb, type Db } from '../db/client.js';
import { buildAutonomyBackend } from '../autonomy/factory.js';
import type { KillSwitchState } from '../autonomy/store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');
  const [command = 'status', ...rest] = argv.slice(2);

  if (!config.databaseUrl) {
    logger.warn(
      'No DATABASE_URL — the kill switch is in-memory and per-process, so this CLI ' +
        'cannot control a separately-running agent. Set DATABASE_URL for a durable switch.',
    );
  }

  const db: Db | undefined = config.databaseUrl ? new PgDb(config.databaseUrl) : undefined;
  const { killSwitch, activityFeed } = buildAutonomyBackend(db);

  try {
    switch (command) {
      case 'stop': {
        const reason = rest.join(' ').trim() || 'engaged from control CLI';
        printState(await killSwitch.engage(reason, 'cli'));
        break;
      }
      case 'resume': {
        printState(await killSwitch.disengage('cli'));
        break;
      }
      case 'feed': {
        const limit = Number(rest[0] ?? '20');
        await printFeed(activityFeed, Number.isSafeInteger(limit) && limit > 0 ? limit : 20);
        break;
      }
      case 'status': {
        printState(await killSwitch.state());
        await printFeed(activityFeed, 10);
        break;
      }
      default:
        logger.error(`Unknown command "${command}". Use: status | stop [reason] | resume | feed [n].`);
        process.exitCode = 1;
    }
  } finally {
    await db?.close();
  }
}

function printState(state: KillSwitchState): void {
  const label = state.engaged ? '\x1b[31mENGAGED (autonomy paused)\x1b[0m' : '\x1b[32mrunning\x1b[0m';
  process.stdout.write(`\nkill switch: ${label}\n`);
  if (state.engaged && state.reason) process.stdout.write(`     reason: ${state.reason}\n`);
  process.stdout.write(`    changed: ${state.changedAt}${state.changedBy ? ` by ${state.changedBy}` : ''}\n`);
}

async function printFeed(
  feed: ReturnType<typeof buildAutonomyBackend>['activityFeed'],
  limit: number,
): Promise<void> {
  const records = await feed.recent(limit);
  if (records.length === 0) {
    process.stdout.write('\nactivity feed: (empty)\n');
    return;
  }
  process.stdout.write(`\nactivity feed (last ${records.length}):\n`);
  for (const r of records) {
    process.stdout.write(
      `  ${r.startedAt}  ${r.status.padEnd(9)}  ${r.trigger}${r.detail ? ` — ${r.detail}` : ''}\n`,
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('control failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
