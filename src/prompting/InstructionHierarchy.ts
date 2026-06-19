export const INSTRUCTION_HIERARCHY = [
  'system_safety_rules',
  'developer_rules',
  'user_instructions',
  'project_instructions',
  'skill_instructions',
  'tool_output',
  'memory',
] as const;

export type InstructionLayer = (typeof INSTRUCTION_HIERARCHY)[number];

export class InstructionHierarchy {
  rank(layer: InstructionLayer): number {
    return INSTRUCTION_HIERARCHY.indexOf(layer);
  }

  canOverride(from: InstructionLayer, to: InstructionLayer): boolean {
    return this.rank(from) < this.rank(to);
  }
}
