/**
 * The concrete Phase-4 scheduled jobs: the morning briefing and the hourly inbox
 * scan. Both are {@link agentJob}s — the agent decides how to use whatever tools
 * are available (Gmail/Calendar imported via MCP, web_search, memory), so these
 * are just the schedule + the instruction, not bespoke logic.
 *
 * Delivery is via the `notify` tool. `notify` is state-mutating (it contacts the
 * principal), so in an autonomous run with no human it would normally queue —
 * which would mean the briefing never arrives. The daemon therefore seeds a
 * standing allow-rule for `notify` (see scripts/scheduler.ts): notifying the
 * single principal about their own day is inherently safe, and it's the one
 * mutation these jobs must be able to perform unattended.
 */

import type { AgentInput } from '../types.js';
import type { AutonomousRunner } from './runner.js';
import { agentJob } from './jobs.js';
import type { ScheduledJob } from './scheduler.js';

export const MORNING_BRIEFING_CRON = '0 6 * * *'; // 06:00 local, daily
export const INBOX_SCAN_CRON = '0 * * * *'; // top of every hour
export const WEEKLY_PROJECT_REPORT_CRON = '0 8 * * 1'; // 08:00 local, Mondays

const BRIEFING_PROMPT = `Produce the principal's morning briefing for today. Use the tools available to you to gather, in this order:
1. Today's calendar events (any calendar tool).
2. A short summary of unread or important email since yesterday evening (any email tool).
3. Overnight news on the principal's tracked topics (use web_search; if you don't know the topics, infer them from memory or skip this section).
4. Anything the principal previously asked you to flag (check memory).
Then send the briefing to the principal with the notify tool: concise and scannable — calendar first, then anything urgent in mail, then news. If a needed capability isn't available, note the gap in one line and continue; never fail the whole briefing over one missing tool.`;

const INBOX_SCAN_PROMPT = `Scan the principal's inbox for messages received in roughly the last hour that are urgent or actionable. Use the available email tools. If you find something genuinely urgent or needing a timely response, notify the principal with a one-paragraph summary including sender and subject. If nothing qualifies, do NOT notify — simply reply that nothing urgent was found. Be conservative: only escalate what truly warrants interrupting the principal.`;

const WEEKLY_PROJECT_REPORT_PROMPT = `Produce the principal's weekly project report covering the last 7 days. Use the tools available to gather context first:
1. The principal's projects and recent decisions (check structured memory: project and decision facts).
2. The current task list (use list_tasks): what's open, in progress, recently completed, and anything overdue.
3. Relevant discussion or activity from the past week (search semantic memory if helpful).
Then write ONE report per active project, each with these sections, kept tight:
- Progress: what moved this week (completed tasks, decisions made).
- Open tasks: what's still outstanding, highlighting anything overdue.
- Risks: what could derail the project.
- Blockers: what is actively stuck and on whom/what it depends.
- Suggested next actions: 2-4 concrete steps for the coming week.
Deliver the full report to the principal with the notify tool — scannable, grouped by project. If there are no tracked projects or tasks, say so in one line rather than inventing work. If a needed capability isn't available, note the gap briefly and continue; never fail the whole report over one missing tool.`;

function eventInput(text: string): AgentInput {
  return { text, source: 'event' };
}

export function morningBriefingJob(runner: AutonomousRunner): ScheduledJob {
  return agentJob({
    name: 'morning-briefing',
    cron: MORNING_BRIEFING_CRON,
    runner,
    input: eventInput(BRIEFING_PROMPT),
  });
}

export function inboxScanJob(runner: AutonomousRunner): ScheduledJob {
  return agentJob({
    name: 'inbox-scan',
    cron: INBOX_SCAN_CRON,
    runner,
    input: eventInput(INBOX_SCAN_PROMPT),
  });
}

export function weeklyProjectReportJob(runner: AutonomousRunner): ScheduledJob {
  return agentJob({
    name: 'weekly-project-report',
    cron: WEEKLY_PROJECT_REPORT_CRON,
    runner,
    input: eventInput(WEEKLY_PROJECT_REPORT_PROMPT),
  });
}
