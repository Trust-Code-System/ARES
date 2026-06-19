import { FORBIDDEN_PERMISSIONS, STATE_CHANGING_PERMISSIONS, type AresPermission } from '../permissions/permissions.js';

export class PermissionPolicy {
  isForbidden(permission: AresPermission): boolean {
    return FORBIDDEN_PERMISSIONS.has(permission);
  }

  requiresConfirmation(permission: AresPermission): boolean {
    return STATE_CHANGING_PERMISSIONS.has(permission) || permission === 'access_secrets';
  }
}
