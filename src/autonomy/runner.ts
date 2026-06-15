/**
 * The autonomous runner — how ARES acts WITHOUT a human at the keyboard.
 *
 * Every Phase-4 trigger (the morning briefing, the hourly inbox scan, a webhook)
 * runs its agent task through here rather than calling `agent.run` directly, so
 * two invariants hold for all autonomous activity in exactly one place:
 *
 *   1. THE KILL SWITCH IS HONORED. If it's engaged when a task arrives, the task
 *      is skipped (never silently dropped — it's recorded). If it's engaged WHILE
 *      a task is running, the run is aborted: the runner subscribes to the in-
 *      process engage event AND polls the (possibly cross-process) switch state,
 *      then trips the AbortSignal the orchestrator already respects.
 *   2. EVERY RUN IS LOGGED to the activity feed — started, then completed/failed/
 *      skipped/aborted — so the dashboard always reflects what autonomy did.
 *
 * State-mutating tool calls are still gated by the confirmation gate inside the
 * agent loop; with no human present those calls queue rather than execute. The
 * kill switch is the bigger hammer: it stops the run itself.
 */

import type { AgentInput, AgentRunResult, Logger } from '../types.js';
import type { ActivityFeed, ActivityStatus, KillSwitch } from './store.js';

/** The slice of the orchestrator the runner needs. The real `Agent` satisfies it. */
export interface AgentLike {
  run(input: AgentInput, signal?: AbortSignal): Promise<AgentRunResult>;
}

export interface AutonomousTask {
  /** Provenance string recorded on the activity feed, e.g. 'schedule:morning_briefing'. */
  trigger: string;
  input: AgentInput;
}

export interface AutonomousRunResult {
  status: ActivityStatus;
  /** The activity feed record id for this task. */
  activityId: string;
  /** The agent run id, once a run started. */
  runId?: string;
  finalText?: string;
}

export interface AutonomousRunnerOptions {
  agent: AgentLike;
  killSwitch: KillSwitch;
  activityFeed: ActivityFeed;
  logger: Logger;
  /**
   * How often to re-check the kill switch while a run is in flight, catching an
   * engagement that came from another process. 0 disables polling (the in-process
   * onEngage event still aborts). Default 1000ms.
   */
  pollIntervalMs?: number;
}

export class AutonomousRunner {
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: AutonomousRunnerOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
  }

  async run(task: AutonomousTask): Promise<AutonomousRunResult> {
    const { killSwitch, activityFeed, logger } = this.opts;
    const activity = await activityFeed.start({ trigger: task.trigger });

    // 1. Gate on the kill switch before doing any work.
    const pre = await killSwitch.state();
    if (pre.engaged) {
      const detail = `skipped — kill switch engaged${pre.reason ? `: ${pre.reason}` : ''}`;
      await activityFeed.finish(activity.id, { status: 'skipped', detail });
      logger.warn('autonomous task skipped — kill switch engaged', {
        trigger: task.trigger,
        reason: pre.reason,
      });
      return { status: 'skipped', activityId: activity.id };
    }

    // 2. Wire the kill switch to an AbortSignal so engaging it mid-run stops us.
    const controller = new AbortController();
    const unsubscribe = killSwitch.onEngage(() => controller.abort());
    const poll = this.startPoll(controller);

    try {
      const result = await this.opts.agent.run(task.input, controller.signal);
      const status = statusFor(result.stopReason);
      const detail =
        `${result.stopReason} · ${result.iterations} step(s) · ${result.toolCalls.length} tool call(s)`;
      await activityFeed.finish(activity.id, { status, detail, runId: result.runId });
      logger.info('autonomous task finished', { trigger: task.trigger, status, runId: result.runId });
      return { status, activityId: activity.id, runId: result.runId, finalText: result.finalText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await activityFeed.finish(activity.id, { status: 'failed', detail: message });
      logger.error('autonomous task threw', { trigger: task.trigger, error: message });
      return { status: 'failed', activityId: activity.id };
    } finally {
      unsubscribe();
      if (poll) clearInterval(poll);
    }
  }

  /** Poll the kill switch on an interval and abort if it becomes engaged. */
  private startPoll(controller: AbortController): NodeJS.Timeout | undefined {
    if (this.pollIntervalMs <= 0) return undefined;
    const timer = setInterval(() => {
      if (controller.signal.aborted) return;
      void this.opts.killSwitch
        .state()
        .then((s) => {
          if (s.engaged) controller.abort();
        })
        .catch(() => {
          // A transient state() failure shouldn't kill the run; next tick retries.
        });
    }, this.pollIntervalMs);
    // Don't let the poll timer keep the process alive on its own.
    timer.unref?.();
    return timer;
  }
}

/** Map the agent's stop reason onto a terminal activity status. */
function statusFor(stopReason: AgentRunResult['stopReason']): ActivityStatus {
  if (stopReason === 'aborted') return 'aborted';
  if (stopReason === 'error') return 'failed';
  // completed, refusal, and max_iterations all "ran to a stop" without crashing.
  return 'completed';
}
