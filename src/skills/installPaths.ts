import path from 'node:path';

export const INSTALLED_REPO_SEGMENTS = ['.installed', 'github'] as const;

export function installedRepoRootFor(skillsRoot: string, filePath: string): {
  root: string;
  owner: string;
  repo: string;
} | undefined {
  const rel = path.relative(path.resolve(skillsRoot), path.resolve(filePath)).split(path.sep);
  if (
    rel[0] !== INSTALLED_REPO_SEGMENTS[0] ||
    rel[1] !== INSTALLED_REPO_SEGMENTS[1] ||
    !rel[2] ||
    !rel[3]
  ) {
    return undefined;
  }
  return {
    root: path.join(path.resolve(skillsRoot), ...INSTALLED_REPO_SEGMENTS, rel[2], rel[3]),
    owner: rel[2],
    repo: rel[3],
  };
}
