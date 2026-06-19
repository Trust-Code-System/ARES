import type { LoadedSkill, SkillExecutionContext } from './manifest.js';

export interface SkillSandboxResult {
  ok: boolean;
  output: string;
}

export class SkillSandboxRunner {
  async dryRun(skill: LoadedSkill, context: SkillExecutionContext): Promise<SkillSandboxResult> {
    return {
      ok: true,
      output: `Prepared skill "${skill.manifest.slug}" for intent "${context.userIntent}". No bundled scripts were executed.`,
    };
  }
}
