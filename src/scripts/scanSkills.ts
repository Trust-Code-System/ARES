/**
 * CLI: vet the vendored skill library for unsafe content.  `npm run scan:skills`
 *
 * Loads every skill, runs the static safety scanner ({@link scanSkills}), prints
 * a grouped report, and exits non-zero when anything reaches the fail threshold
 * (default `critical`) so it can gate CI / a pre-vendor check. Pass a threshold
 * as the first arg: `npm run scan:skills -- high`.
 *
 * Advisory only — it reads files, never executes or edits a skill.
 */

import { loadConfig } from '../config.js';
import { ConsoleLogger } from '../logging/logger.js';
import { loadSkillIndex } from '../skills/loader.js';
import {
  formatScanReport,
  hasSeverityAtLeast,
  scanSkills,
  SEVERITY_RANK,
  type Severity,
} from '../skills/scanner.js';

function main(): void {
  const config = loadConfig();
  const logger = new ConsoleLogger('info');

  const arg = process.argv[2]?.toLowerCase();
  const threshold: Severity =
    arg && arg in SEVERITY_RANK ? (arg as Severity) : 'critical';

  if (!config.skillsDir) {
    logger.warn('Skills are disabled (ARES_SKILLS_ENABLED=false) — nothing to scan.');
    return;
  }

  const index = loadSkillIndex(config.skillsDir, logger);
  const results = scanSkills(index.all);

  // eslint-disable-next-line no-console
  console.log(formatScanReport(results, config.skillsDir));
  // eslint-disable-next-line no-console
  console.log(
    `\nScanned ${index.size} skills · ${results.length} with findings · fail threshold: ${threshold}`,
  );

  if (hasSeverityAtLeast(results, threshold)) {
    logger.error(`Findings at or above "${threshold}" — review before shipping.`);
    process.exitCode = 1;
  }
}

main();
