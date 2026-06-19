import { PermissionManager, type PermissionDecision } from '../permissions/PermissionManager.js';
import type { SkillManifest } from './manifest.js';

export class SkillPermissionManager {
  constructor(private readonly permissions = new PermissionManager()) {}

  evaluate(manifest: SkillManifest): PermissionDecision {
    return this.permissions.evaluate(manifest.permissions, manifest.human_confirmation_required);
  }
}
