import { containsSensitiveData } from '../security/redactor.js';

export type MemoryType =
  | 'user_preference'
  | 'project_context'
  | 'task_history'
  | 'skill_execution_history'
  | 'safe_contact_reference'
  | 'document_template'
  | 'reusable_instruction'
  | 'long_term_project_fact';

export interface MemoryPolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

export class MemoryPolicy {
  evaluate(value: unknown, type: MemoryType): MemoryPolicyDecision {
    if (containsSensitiveData(value)) {
      return { allowed: false, requiresConfirmation: false, reason: 'memory contains authentication or payment secrets' };
    }
    const requiresConfirmation = type === 'long_term_project_fact' || type === 'safe_contact_reference';
    return { allowed: true, requiresConfirmation };
  }
}
