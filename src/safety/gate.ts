/**
 * The rule-based confirmation gate (Phase 3).
 *
 * Decision order for a state-mutating tool call:
 *   1. Mode short-circuit — `auto` approves (dev), `deny` blocks (read-only safe
 *      mode). Preserves the Phase-1 config semantics.
 *   2. Standing rules — a matching `allow`/`deny` rule decides without a human
 *      (deny wins). This is the "explicit pre-authorized rule" escape hatch.
 *   3. Human present (TTY/injected prompter) — prompt: y / n / a(lways allow
 *      this exact input). "always" persists a narrow standing rule.
 *   4. No human — park the request in the confirmation queue and return
 *      not-approved with the queue id. Autonomous runs (Phase 4) thus never
 *      silently mutate state, and never hang waiting on a prompt either.
 *
 * Implements the same {@link ConfirmationGate} interface as Phase 1, so the
 * orchestrator is unchanged.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ConfirmationGate, GateDecision, Logger, Tool } from '../types.js';
import type { ConfirmationMode, ConfirmationPrompt } from '../tools/confirmation.js';
import { evaluateRules, type ConfirmationQueueStore, type StandingRulesStore } from './store.js';
import type { SpendCapEnforcer } from './caps.js';
import { containsSensitiveData, redactSensitiveData } from '../security/redactor.js';

export interface RuleBasedGateOptions {
  mode: ConfirmationMode;
  rules: StandingRulesStore;
  queue: ConfirmationQueueStore;
  logger: Logger;
  /** Interactive prompter. If omitted, a TTY readline is used; absent a TTY, requests are queued. */
  prompt?: ConfirmationPrompt;
  /** Hard spend/trade caps. Checked first and override everything, including auto mode. */
  caps?: SpendCapEnforcer;
}

export class RuleBasedConfirmationGate implements ConfirmationGate {
  constructor(private readonly opts: RuleBasedGateOptions) {}

  async requestApproval(req: {
    tool: Tool;
    input: unknown;
    runId: string;
  }): Promise<GateDecision> {
    if (containsSensitiveData(req.input)) {
      this.opts.logger.warn('action blocked because input contains sensitive authentication data', {
        tool: req.tool.name,
      });
      return {
        approved: false,
        reason:
          'blocked: tool input appears to contain a password, OTP, PIN, private key, cookie, token, CVV, or other authentication secret. Ask the user to enter it manually.',
      };
    }

    // 0. Spend/trade caps are a hard ceiling enforced in code: no mode, rule, or
    //    human can approve a call that breaches a cap. Checked before anything else.
    if (this.opts.caps) {
      const cap = await this.opts.caps.check(req.tool, req.input);
      if (!cap.ok) {
        this.opts.logger.warn('action blocked by spend cap', { tool: req.tool.name, reason: cap.reason });
        return { approved: false, reason: `blocked by hard spend cap: ${cap.reason}` };
      }
    }

    const decision = await this.decide(req);

    // Record an approved call's cost so it counts toward the rolling window.
    if (decision.approved && this.opts.caps) await this.opts.caps.commit(req.tool, req.input);
    return decision;
  }

  private async decide(req: { tool: Tool; input: unknown; runId: string }): Promise<GateDecision> {
    // 1. Mode short-circuits.
    if (this.opts.mode === 'auto') return { approved: true, reason: 'auto-approve mode (dev)' };
    if (this.opts.mode === 'deny') {
      return { approved: false, reason: 'deny mode (read-only safe mode) — state mutation blocked' };
    }

    // 2. Standing rules.
    const rules = await this.opts.rules.findForTool(req.tool.name);
    const ruling = evaluateRules(rules, req.input);
    if (ruling) {
      return {
        approved: ruling.effect === 'allow',
        reason: `${ruling.effect === 'allow' ? 'pre-authorized' : 'pre-denied'} by standing rule: ${ruling.reason}`,
      };
    }

    // 3. Human present → prompt.
    if (this.canPrompt()) return this.promptHuman(req.tool, req.input);

    // 4. No human → queue and defer.
    const item = await this.opts.queue.enqueue({
      runId: req.runId,
      tool: req.tool.name,
      input: redactSensitiveData(req.input),
      reason: 'no standing rule and no human present at decision time',
    });
    this.opts.logger.warn('action queued for approval', { tool: req.tool.name, queueId: item.id });
    return {
      approved: false,
      reason: `No standing rule and no human present; queued for approval (id=${item.id}).`,
    };
  }

  private canPrompt(): boolean {
    return Boolean(this.opts.prompt) || stdin.isTTY === true;
  }

  private async promptHuman(tool: Tool, input: unknown): Promise<GateDecision> {
    stdout.write(
      `\n\x1b[33m⚠  ARES wants to run a state-mutating tool:\x1b[0m\n` +
        `   tool:  ${tool.name}\n` +
        `   input: ${JSON.stringify(redactSensitiveData(input))}\n`,
    );
    const answer = (
      await this.ask('   approve? [y]es / [n]o / [a]lways this exact input: ')
    ).trim().toLowerCase();

    if (answer === 'a' || answer === 'always') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {
          approved: true,
          reason: 'approved by human; standing rule skipped because the tool input was not an object',
        };
      }
      // Persist only this exact input. A tool-wide allow would silently broaden
      // one approval (for example, one recipient) to every future call.
      const rule = await this.opts.rules.add({
        tool: tool.name,
        match: redactSensitiveData(structuredClone(input as Record<string, unknown>)),
        effect: 'allow',
        reason: `user chose "always allow" for this ${tool.name} input`,
      });
      this.opts.logger.info('standing rule created', { tool: tool.name, ruleId: rule.id });
      return { approved: true, reason: `approved + standing allow-rule created (${rule.id})` };
    }

    const approved = answer === 'y' || answer === 'yes';
    return {
      approved,
      reason: approved ? 'approved by human at terminal' : 'rejected by human at terminal',
    };
  }

  private async ask(question: string): Promise<string> {
    if (this.opts.prompt) return this.opts.prompt(question);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
}
