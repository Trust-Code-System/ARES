/**
 * CLI skill importer.
 *
 * Thin wrapper over the same {@link installSkillRepo} installer the chat
 * `install_skill_repo` tool and the `POST /api/skills/import` endpoint use, so
 * all three import routes behave identically: clone files only (never execute
 * repo code), run the static scanner, refuse activation on critical+ findings,
 * and activate into the managed `skills/.installed/owner/repo` area.
 *
 *   npm run skills:import -- https://github.com/org/repo [more-urls...]
 *   npm run skills:import -- https://github.com/org/repo#branch
 */

import type { Logger, LogLevel } from '../src/types.js';
import { installSkillRepo } from '../src/skills/installer.js';

const args = process.argv.slice(2);
const repos = args.filter((arg) => arg.startsWith('https://github.com/') || arg.startsWith('github.com/'));
if (repos.length === 0) {
  console.log('Usage: npm run skills:import -- https://github.com/org/repo [more-urls...]');
  console.log('       Append #ref to pin a branch/tag, e.g. .../repo#main');
  process.exit(0);
}

const skillsDir = process.env.ARES_SKILLS_DIR ?? 'skills';

const logger: Logger = {
  log(_level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    console.error(`  ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
  debug() {},
  info(msg, meta) {
    console.error(`  ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
  warn(msg, meta) {
    console.error(`  ! ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
  error(msg, meta) {
    console.error(`  ✗ ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
};

let installed = 0;
let failed = 0;

for (const raw of repos) {
  // Support a convenient `url#ref` shorthand (the installer also honours /tree/ URLs).
  const hashIndex = raw.indexOf('#');
  const url = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const ref = hashIndex >= 0 ? raw.slice(hashIndex + 1) : undefined;
  try {
    const result = await installSkillRepo({
      skillsDir,
      url,
      ...(ref ? { ref } : {}),
      logger,
    });
    installed += result.skillsInstalled;
    console.log(
      `✓ ${result.owner}/${result.repo}${result.ref ? `@${result.ref}` : ''}: ` +
        `${result.skillsInstalled} skill(s) installed at ${result.dir} ` +
        `(worst finding: ${result.worstFinding ?? 'none'})`,
    );
  } catch (err) {
    failed++;
    console.error(`✗ ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nDone. Installed ${installed} skill(s) across ${repos.length - failed}/${repos.length} repo(s).`);
console.log('Run `npm run skills:list` to see them. Installed skills are active immediately (scan passed).');
process.exitCode = failed > 0 ? 1 : 0;
