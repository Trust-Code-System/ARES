import { isAresPermission } from '../permissions/permissions.js';
import type { SkillManifest } from './manifest.js';

export interface SkillValidationResult {
  ok: boolean;
  errors: string[];
}

const REQUIRED_STRING_FIELDS = [
  'name',
  'slug',
  'description',
  'category',
  'rollback_plan',
  'version',
  'source_repo',
  'adapted_from',
  'license_notes',
] as const;

const REQUIRED_ARRAY_FIELDS = [
  'when_to_use',
  'when_not_to_use',
  'required_tools',
  'optional_tools',
  'permissions',
  'workflow_steps',
  'verification_steps',
  'examples',
  'failure_modes',
  'allowed_actions',
  'forbidden_actions',
] as const;

export class SkillValidator {
  validate(value: unknown): SkillValidationResult {
    const errors: string[] = [];
    if (typeof value !== 'object' || value === null) return { ok: false, errors: ['manifest must be an object'] };
    const record = value as Record<string, unknown>;

    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof record[field] !== 'string' || !record[field].trim()) errors.push(`${field} is required`);
    }
    for (const field of REQUIRED_ARRAY_FIELDS) {
      if (!Array.isArray(record[field])) errors.push(`${field} must be an array`);
    }
    if (record.safety_level !== 'low' && record.safety_level !== 'medium' && record.safety_level !== 'high' && record.safety_level !== 'critical') {
      errors.push('safety_level must be low, medium, high, or critical');
    }
    if (typeof record.human_confirmation_required !== 'boolean') errors.push('human_confirmation_required must be boolean');
    if (typeof record.input_schema !== 'object' || record.input_schema === null) errors.push('input_schema must be an object');
    if (typeof record.output_schema !== 'object' || record.output_schema === null) errors.push('output_schema must be an object');

    if (Array.isArray(record.permissions)) {
      for (const permission of record.permissions) {
        if (typeof permission !== 'string' || !isAresPermission(permission)) errors.push(`unknown permission: ${String(permission)}`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  assert(value: unknown): SkillManifest {
    const result = this.validate(value);
    if (!result.ok) throw new Error(`Invalid skill manifest: ${result.errors.join('; ')}`);
    return value as SkillManifest;
  }
}
