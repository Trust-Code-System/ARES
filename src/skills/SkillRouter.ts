import type { RiskLevel } from '../permissions/permissions.js';
import { RiskClassifier } from '../permissions/RiskClassifier.js';
import { SkillPermissionManager } from './SkillPermissionManager.js';
import type { SkillRouteDecision } from './manifest.js';
import { SkillRegistry } from './SkillRegistry.js';

export class SkillRouter {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly permissions = new SkillPermissionManager(),
    private readonly risk = new RiskClassifier(),
  ) {}

  route(userIntent: string, limit = 3): SkillRouteDecision {
    const selected = [];
    const rejected: Array<{ slug: string; reason: string }> = [];
    let confirmationRequired = false;
    let highest: RiskLevel = 'low';

    for (const skill of this.registry.search(userIntent, limit)) {
      const decision = this.permissions.evaluate(skill.manifest);
      if (!decision.allowed) {
        rejected.push({ slug: skill.manifest.slug, reason: decision.reason ?? 'permission denied' });
        continue;
      }
      selected.push(skill);
      confirmationRequired ||= decision.confirmationRequired;
      highest = maxRisk(highest, decision.assessment.risk);
    }

    if (selected.length > 0) {
      const permissions = selected.flatMap((skill) => skill.manifest.permissions);
      const assessment = this.risk.classify(permissions);
      highest = maxRisk(highest, assessment.risk);
      confirmationRequired ||= assessment.confirmationRequired;
    }

    return { selected, rejected, confirmationRequired, risk: highest };
  }
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return rank[a] >= rank[b] ? a : b;
}
