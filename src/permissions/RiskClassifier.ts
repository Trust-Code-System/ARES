import {
  PERMISSION_RISK,
  STATE_CHANGING_PERMISSIONS,
  type AresPermission,
  type RiskLevel,
  highestRisk,
} from './permissions.js';

export interface RiskAssessment {
  risk: RiskLevel;
  reasons: string[];
  confirmationRequired: boolean;
}

export class RiskClassifier {
  classify(permissions: readonly AresPermission[], declaredRisk?: RiskLevel): RiskAssessment {
    const risk = maxRisk(highestRisk(permissions), declaredRisk ?? 'low');
    const reasons = permissions.map((permission) => `${permission}: ${PERMISSION_RISK[permission]}`);
    const confirmationRequired = risk === 'critical' || permissions.some((p) => STATE_CHANGING_PERMISSIONS.has(p));
    return { risk, reasons, confirmationRequired };
  }
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return rank[a] >= rank[b] ? a : b;
}
