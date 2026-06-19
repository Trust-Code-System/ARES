/**
 * SMTP {@link EmailSender} (nodemailer), built from config.
 *
 * Kept out of email.ts so the tool/safety layer has no nodemailer dependency
 * (tests inject a fake sender). nodemailer is imported lazily, so the app boots
 * without it and only pays the cost when sending is enabled.
 *
 * Credentials come from env (an app password is a secret you hold, not one ARES
 * stores); the redactor keeps them out of logs and the audit trail. Returns
 * undefined when email is disabled or no SMTP host is set, in which case
 * send_email is simply not registered and ARES can only draft.
 */

import type { EmailConfig } from '../config.js';
import type { EmailSender } from './builtin/email.js';

export function buildEmailSender(config: EmailConfig): EmailSender | undefined {
  if (!config.enabled || !config.host) return undefined;

  return async (msg) => {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
    });
    const info = await transport.sendMail({
      from: config.from ?? config.user,
      to: msg.to,
      ...(msg.cc ? { cc: msg.cc } : {}),
      ...(msg.bcc ? { bcc: msg.bcc } : {}),
      subject: msg.subject,
      text: msg.body,
    });
    return { id: info.messageId };
  };
}
