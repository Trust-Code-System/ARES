import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { redactSensitiveData } from '../security/redactor.js';

export interface SkillAuditEvent {
  type: 'loaded' | 'rejected' | 'routed' | 'executed' | 'enabled' | 'disabled' | 'imported';
  skill?: string;
  message: string;
  metadata?: Record<string, unknown>;
  at?: string;
}

export class SkillAuditLogger {
  constructor(private readonly logPath = path.resolve('logs', 'skill-audit.jsonl')) {}

  record(event: SkillAuditEvent): void {
    mkdirSync(path.dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(redactSensitiveData({ ...event, at: event.at ?? new Date().toISOString() }))}\n`, 'utf8');
  }
}
