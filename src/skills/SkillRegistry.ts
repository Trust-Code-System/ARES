import type { LoadedSkill } from './manifest.js';

export class SkillRegistry {
  private readonly bySlug = new Map<string, LoadedSkill>();

  constructor(skills: readonly LoadedSkill[] = []) {
    for (const skill of skills) this.register(skill);
  }

  register(skill: LoadedSkill): void {
    if (this.bySlug.has(skill.manifest.slug)) throw new Error(`Duplicate skill slug: ${skill.manifest.slug}`);
    this.bySlug.set(skill.manifest.slug, skill);
  }

  get(slug: string): LoadedSkill | undefined {
    return this.bySlug.get(slug);
  }

  list(): LoadedSkill[] {
    return [...this.bySlug.values()];
  }

  search(intent: string, limit = 5): LoadedSkill[] {
    const terms = new Set(intent.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    return this.list()
      .map((skill) => ({ skill, score: relevance(skill, terms, intent.toLowerCase()) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.manifest.slug.localeCompare(b.skill.manifest.slug))
      .slice(0, limit)
      .map((entry) => ({ ...entry.skill, relevanceScore: entry.score }));
  }
}

function relevance(skill: LoadedSkill, terms: Set<string>, phrase: string): number {
  const manifest = skill.manifest;
  const haystack = [
    manifest.name,
    manifest.slug,
    manifest.description,
    manifest.category,
    ...manifest.when_to_use,
    ...manifest.workflow_steps,
  ].join(' ').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (term.length > 2 && haystack.includes(term)) score += 1;
  }
  if (phrase && haystack.includes(phrase)) score += 10;
  if (manifest.enabled === false) score = 0;
  return score;
}
