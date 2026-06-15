/**
 * Job builders — the bridge from a schedule to the autonomous runner.
 *
 * A scheduled job is just a name + cron + handler; these helpers produce handlers
 * that do the two kinds of work Phase 4 needs:
 *   - {@link agentJob}: fire an agent task through the {@link AutonomousRunner}, so
 *     the kill switch and activity feed apply. This is how the morning briefing and
 *     hourly inbox scan will be defined once their tools exist.
 *   - {@link maintenanceJob}: run a plain async maintenance function (e.g. nightly
 *     memory consolidation) that isn't an agent run.
 */

import type { AgentInput } from '../types.js';
import type { AutonomousRunner } from './runner.js';
import type { ScheduledJob } from './scheduler.js';

/** A scheduled job that runs an agent task autonomously. */
export function agentJob(opts: {
  name: string;
  cron: string;
  runner: AutonomousRunner;
  input: AgentInput;
}): ScheduledJob {
  return {
    name: opts.name,
    cron: opts.cron,
    handler: async () => {
      await opts.runner.run({ trigger: `schedule:${opts.name}`, input: opts.input });
    },
  };
}

/** A scheduled job that runs a plain maintenance function (not an agent run). */
export function maintenanceJob(opts: {
  name: string;
  cron: string;
  run: () => Promise<void>;
}): ScheduledJob {
  return { name: opts.name, cron: opts.cron, handler: opts.run };
}
