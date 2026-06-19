/**
 * The confirmation gate.
 *
 * Every state-mutating tool call passes through here before it runs. This is the
 * code-level enforcement of the safety principle: "Every action that mutates
 * external state requires either a confirmation step or an explicit
 * pre-authorized rule."
 *
 * Phase 1 ships three simple modes. Phase 3 will add a standing-rules engine and
 * a persistent confirmation queue; both slot in behind the same
 * {@link ConfirmationGate} interface.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ConfirmationGate, GateDecision, Logger, Tool } from '../types.js';
import { containsSensitiveData, redactSensitiveData } from '../security/redactor.js';

export type ConfirmationMode = 'auto' | 'deny' | 'prompt';
export type ConfirmationPrompt = (question: string) => Promise<string>;

export class BasicConfirmationGate implements ConfirmationGate {
  constructor(
    private readonly mode: ConfirmationMode,
    private readonly logger: Logger,
    private readonly prompt?: ConfirmationPrompt,
  ) {}

  async requestApproval(req: {
    tool: Tool;
    input: unknown;
    runId: string;
  }): Promise<GateDecision> {
    if (containsSensitiveData(req.input)) {
      return {
        approved: false,
        reason:
          'blocked: tool input appears to contain a password, OTP, PIN, private key, cookie, token, CVV, or other authentication secret.',
      };
    }
    switch (this.mode) {
      case 'auto':
        return { approved: true, reason: 'auto-approve mode (dev)' };

      case 'deny':
        return {
          approved: false,
          reason: 'deny mode (read-only safe mode) — state mutation blocked',
        };

      case 'prompt':
        return this.promptHuman(req.tool, req.input);
    }
  }

  private async promptHuman(tool: Tool, input: unknown): Promise<GateDecision> {
    stdout.write(
      `\n\x1b[33m⚠  ARES wants to run a state-mutating tool:\x1b[0m\n` +
        `   tool:  ${tool.name}\n` +
        `   input: ${JSON.stringify(redactSensitiveData(input))}\n`,
    );
    const answer = (await this.ask('   approve? [y/N] ')).trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes';
    return {
      approved,
      reason: approved ? 'approved by human at terminal' : 'rejected by human at terminal',
    };
  }

  private async ask(question: string): Promise<string> {
    if (this.prompt) return this.prompt(question);

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
}
