import type { LoadedSkill } from './manifest.js';

export class SkillVersionManager {
  latest(skills: readonly LoadedSkill[]): LoadedSkill[] {
    const bySlug = new Map<string, LoadedSkill>();
    for (const skill of skills) {
      const current = bySlug.get(skill.manifest.slug);
      if (!current || compareVersion(skill.manifest.version, current.manifest.version) > 0) {
        bySlug.set(skill.manifest.slug, skill);
      }
    }
    return [...bySlug.values()];
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number(part) || 0);
  const pb = b.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
