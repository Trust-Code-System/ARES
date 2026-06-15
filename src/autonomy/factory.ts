/**
 * Autonomy backend wiring. Mirrors the memory and safety factories: durable
 * Postgres stores when a Db is available, in-memory otherwise. Returns the kill
 * switch and activity feed so the runner, the control CLI, and (Phase 5) the
 * dashboard all reach the same instances.
 *
 * It takes an already-built Db (shared with the memory + safety backends) rather
 * than opening its own, so the whole app multiplexes one connection pool.
 */

import type { Config } from '../config.js';
import type { Logger } from '../types.js';
import type { Db } from '../db/client.js';
import {
  InMemoryActivityFeed,
  InMemoryKillSwitch,
  type ActivityFeed,
  type KillSwitch,
} from './store.js';
import { PgActivityFeed, PgKillSwitch } from './pgStore.js';
import { InMemoryScheduler, type Scheduler } from './scheduler.js';
import { BullMqScheduler } from './bullmqScheduler.js';

export interface AutonomyBackend {
  killSwitch: KillSwitch;
  activityFeed: ActivityFeed;
}

export function buildAutonomyBackend(db: Db | undefined): AutonomyBackend {
  return {
    killSwitch: db ? new PgKillSwitch(db) : new InMemoryKillSwitch(),
    activityFeed: db ? new PgActivityFeed(db) : new InMemoryActivityFeed(),
  };
}

/**
 * The scheduler is built separately from the stores because only the long-running
 * autonomy daemon needs it (the REPL and one-shot CLIs don't). Durable BullMQ when
 * REDIS_URL is set, in-memory otherwise.
 */
export function buildScheduler(config: Config, logger: Logger): Scheduler {
  if (config.redisUrl) return new BullMqScheduler(config.redisUrl, logger);
  logger.warn(
    'No REDIS_URL — using the in-memory scheduler. Jobs run only while this process is ' +
      'alive and schedules do NOT persist across restarts. Set REDIS_URL for durable scheduling.',
  );
  return new InMemoryScheduler(logger);
}
