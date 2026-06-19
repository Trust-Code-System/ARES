import type { AresPermission } from '../permissions/permissions.js';

export interface SkillSandboxPolicyConfig {
  allowNetwork: boolean;
  allowShell: boolean;
  allowedPaths: string[];
}

export class SkillSandboxPolicy {
  static fromPermissions(permissions: readonly AresPermission[], skillDir: string): SkillSandboxPolicyConfig {
    return {
      allowNetwork: permissions.includes('access_network'),
      allowShell: permissions.includes('run_shell'),
      allowedPaths: [skillDir],
    };
  }
}
