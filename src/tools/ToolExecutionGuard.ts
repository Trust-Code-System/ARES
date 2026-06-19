import { PermissionManager } from '../permissions/PermissionManager.js';
import type { ToolDefinition } from './ToolDefinition.js';

export class ToolExecutionGuard {
  constructor(private readonly permissions = new PermissionManager()) {}

  check(tool: ToolDefinition): { allowed: boolean; confirmationRequired: boolean; reason?: string } {
    const decision = this.permissions.evaluate(tool.permissions_required, tool.confirmation_required);
    return {
      allowed: decision.allowed,
      confirmationRequired: decision.confirmationRequired,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }
}
