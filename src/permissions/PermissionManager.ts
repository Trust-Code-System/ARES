import { FORBIDDEN_PERMISSIONS, STATE_CHANGING_PERMISSIONS, type AresPermission } from './permissions.js';
import type { RiskAssessment } from './RiskClassifier.js';
import { RiskClassifier } from './RiskClassifier.js';

export interface PermissionDecision {
  allowed: boolean;
  confirmationRequired: boolean;
  deniedPermissions: AresPermission[];
  assessment: RiskAssessment;
  reason?: string;
}

export class PermissionManager {
  constructor(private readonly classifier = new RiskClassifier()) {}

  evaluate(permissions: readonly AresPermission[], humanConfirmationRequired = false): PermissionDecision {
    const deniedPermissions = permissions.filter((p) => FORBIDDEN_PERMISSIONS.has(p));
    const assessment = this.classifier.classify(permissions);
    const confirmationRequired =
      humanConfirmationRequired ||
      assessment.confirmationRequired ||
      permissions.some((permission) => STATE_CHANGING_PERMISSIONS.has(permission));

    if (deniedPermissions.length > 0) {
      return {
        allowed: false,
        confirmationRequired,
        deniedPermissions,
        assessment,
        reason: `Forbidden permission requested: ${deniedPermissions.join(', ')}`,
      };
    }

    return { allowed: true, confirmationRequired, deniedPermissions, assessment };
  }
}
