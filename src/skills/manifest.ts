import type { AresPermission, RiskLevel } from '../permissions/permissions.js';

export interface SkillManifest {
  name: string;
  slug: string;
  description: string;
  category: string;
  when_to_use: string[];
  when_not_to_use: string[];
  required_tools: string[];
  optional_tools: string[];
  permissions: AresPermission[];
  safety_level: RiskLevel;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  workflow_steps: string[];
  verification_steps: string[];
  examples: string[];
  failure_modes: string[];
  rollback_plan: string;
  human_confirmation_required: boolean;
  allowed_actions: string[];
  forbidden_actions: string[];
  version: string;
  source_repo: string;
  adapted_from: string;
  license_notes: string;
  enabled?: boolean;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  skillMarkdown: string;
  dir: string;
  metadataPath: string;
  skillPath: string;
  auditStatus: 'passed' | 'failed';
  auditFindings: Array<{
    scanner: string;
    rule: string;
    severity: string;
    file: string;
    line: number;
    excerpt: string;
  }>;
  relevanceScore?: number;
}

export interface SkillExecutionContext {
  userIntent: string;
  workspaceDir: string;
  userId?: string;
  runId?: string;
  approvedPermissions: string[];
  memory?: unknown;
  toolResults?: unknown[];
}

export interface SkillRouteDecision {
  selected: LoadedSkill[];
  rejected: Array<{ slug: string; reason: string }>;
  confirmationRequired: boolean;
  risk: RiskLevel;
}
