/**
 * Email tools: draft_email (always on) and send_email (opt-in, gated).
 *
 * Safety model (the master prompt's email rule): ARES drafts freely but NEVER
 * sends without confirmation.
 *   - draft_email is read_only — it composes a reviewable draft and returns it;
 *     it does not send and touches no external state. Always registered.
 *   - send_email is state_mutating — it goes through the confirmation gate like
 *     every external action. It is registered ONLY when an {@link EmailSender} is
 *     configured (ARES_EMAIL_ENABLED + SMTP), so the model never sees a send
 *     capability ARES can't fulfil. ARES never stores the SMTP password — it
 *     lives in env and the redactor keeps it out of logs/audit.
 *
 * The sender is injected, so the gate/validation logic is unit-tested with no
 * real SMTP (see tests/email.test.ts). The concrete SMTP sender lives in
 * src/tools/emailSender.ts and lazily loads nodemailer.
 */

import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export interface EmailMessage {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}

/** Sends a message and returns a transport id. Injected; real impl uses SMTP. */
export type EmailSender = (msg: EmailMessage) => Promise<{ id: string }>;

const emailShape = {
  to: z.string().describe('Recipient address(es), comma-separated.'),
  subject: z.string().describe('Subject line.'),
  body: z.string().describe('Plain-text body.'),
  cc: z.string().describe('Cc address(es), comma-separated.').optional(),
  bcc: z.string().describe('Bcc address(es), comma-separated.').optional(),
};

/** Looks like at least one `local@domain` address somewhere in the field. */
function looksLikeEmail(field: string): boolean {
  return /[^\s,@]+@[^\s,@]+\.[^\s,@]+/.test(field);
}

/** Render a message as a readable, RFC-822-style draft. */
export function formatDraft(msg: EmailMessage): string {
  const lines = [`To: ${msg.to}`];
  if (msg.cc) lines.push(`Cc: ${msg.cc}`);
  if (msg.bcc) lines.push(`Bcc: ${msg.bcc}`);
  lines.push(`Subject: ${msg.subject}`, '', msg.body);
  return lines.join('\n');
}

export function createEmailTools(opts: { sender?: EmailSender } = {}): Tool[] {
  const draft = defineTool({
    name: 'draft_email',
    description:
      'Compose an email DRAFT and return it for review. Read-only: it does NOT send. ' +
      'Use this to prepare any message; show the draft to the user and, only if they ' +
      'confirm, use send_email (if available) to send it.',
    kind: 'read_only',
    schema: z.object(emailShape),
    async execute(input): Promise<ToolResult> {
      if (!looksLikeEmail(input.to)) {
        return { ok: false, content: `"${input.to}" does not look like an email address.` };
      }
      const msg: EmailMessage = {
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.cc ? { cc: input.cc } : {}),
        ...(input.bcc ? { bcc: input.bcc } : {}),
      };
      return {
        ok: true,
        content: `Draft ready (not sent):\n\n${formatDraft(msg)}`,
        data: { draft: msg },
      };
    },
  });

  const tools: Tool[] = [draft];

  // send_email is registered only when a transport is configured.
  const sender = opts.sender;
  if (sender) {
    tools.push(
      defineTool({
        name: 'send_email',
        description:
          'SEND an email — a high-risk, external, state-changing action. Always requires ' +
          'confirmation. Draft with draft_email first, show the user, and send only after ' +
          'they approve. Never invent recipients or content.',
        kind: 'state_mutating',
        schema: z.object(emailShape),
        async execute(input): Promise<ToolResult> {
          if (!looksLikeEmail(input.to)) {
            return { ok: false, content: `"${input.to}" does not look like an email address.` };
          }
          const msg: EmailMessage = {
            to: input.to,
            subject: input.subject,
            body: input.body,
            ...(input.cc ? { cc: input.cc } : {}),
            ...(input.bcc ? { bcc: input.bcc } : {}),
          };
          const { id } = await sender(msg);
          return { ok: true, content: `Sent email to ${msg.to} (id ${id}).`, data: { id, to: msg.to } };
        },
      }),
    );
  }

  return tools;
}
