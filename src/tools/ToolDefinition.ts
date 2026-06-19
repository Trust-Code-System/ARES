import type { AresPermission, RiskLevel } from '../permissions/permissions.js';

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  permissions_required: AresPermission[];
  risk_level: RiskLevel;
  confirmation_required: boolean;
  timeout: number;
  logging_policy: 'none' | 'metadata' | 'redacted_input_output';
  execute?: (input: Input) => Promise<Output>;
}
