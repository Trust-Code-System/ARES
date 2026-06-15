/**
 * Training-dataset CLI.  `npm run train:<cmd> -- <dataset.json> [options]`
 *
 * Subcommands (all read a dataset JSON file; see docs/DATASET_FORMAT.md):
 *   validate <file>                         structural + secret/PII check (non-zero exit on error)
 *   sanitize <file> [--out f]               redact secrets/PII, write a clean copy
 *   split    <file> [--out-dir d] [--train 0.8] [--val 0.1]   deterministic train/val/test
 *   export   <file> --format openai|jsonl|csv [--out f] [--system "..."]
 *
 * Pure data tooling — no network, no model calls. The sanitizer runs implicitly
 * inside `export` too, so nothing leaves with a credential in it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Dataset } from '../ai-training/types.js';
import { validateDataset } from '../ai-training/validate.js';
import { sanitizeDataset, splitDataset } from '../ai-training/dataset.js';
import { toCsv, toJsonl, toOpenAIChatJsonl } from '../ai-training/export.js';
import { hasCredential, scanSecrets } from '../ai-training/sanitizer.js';

function die(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Tiny flag parser: --key value / --key=value. Returns a map plus positionals. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
        else flags[a.slice(2)] = 'true';
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function loadDataset(file: string): Dataset {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    die(`cannot read "${file}": ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Dataset;
  } catch (err) {
    die(`"${file}" is not valid JSON: ${(err as Error).message}`);
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const file = positional[0];
  if (!cmd) die('usage: train <validate|sanitize|split|export> <dataset.json> [options]');
  if (!file) die(`usage: train ${cmd} <dataset.json> [options]`);

  const dataset = loadDataset(file);
  const stem = path.basename(file).replace(/\.json$/i, '');
  const dir = path.dirname(file);

  switch (cmd) {
    case 'validate': {
      const report = validateDataset(dataset);
      for (const issue of report.issues) {
        const where = issue.index >= 0 ? `#${issue.index}` : 'dataset';
        log(`  [${issue.level}] ${where}: ${issue.message}`);
      }
      log(`\n${dataset.name} v${dataset.version}: ${report.total} examples · ${report.errors} error(s) · ${report.warnings} warning(s)`);
      if (!report.ok) process.exit(1);
      log('OK — structure valid and no hard credentials present.');
      break;
    }

    case 'sanitize': {
      const { dataset: clean, report, redactedCount } = sanitizeDataset(dataset);
      const out = flags.out ?? path.join(dir, `${stem}.sanitized.json`);
      writeFileSync(out, JSON.stringify(clean, null, 2));
      for (const r of report) log(`  #${r.index} (${r.id}): redacted ${r.findings.map((f) => f.kind).join(', ')}`);
      log(`\nRedacted ${redactedCount} example(s). Wrote ${out}`);
      break;
    }

    case 'split': {
      const trainFrac = flags.train ? Number(flags.train) : undefined;
      const valFrac = flags.val ? Number(flags.val) : undefined;
      const split = splitDataset(dataset.examples, {
        ...(trainFrac !== undefined ? { trainFrac } : {}),
        ...(valFrac !== undefined ? { valFrac } : {}),
        seed: dataset.name,
      });
      const outDir = flags['out-dir'] ?? path.join(dir, `${stem}.split`);
      mkdirSync(outDir, { recursive: true });
      for (const part of ['train', 'validation', 'test'] as const) {
        const p = path.join(outDir, `${part}.json`);
        writeFileSync(p, JSON.stringify({ ...dataset, examples: split[part] }, null, 2));
      }
      log(`Split → ${outDir}  (train=${split.train.length}, validation=${split.validation.length}, test=${split.test.length})`);
      break;
    }

    case 'export': {
      const format = flags.format;
      if (!format || !['openai', 'jsonl', 'csv'].includes(format)) {
        die('export requires --format openai|jsonl|csv');
      }
      // Sanitize before any export so a credential can never leave with the file.
      const { dataset: clean } = sanitizeDataset(dataset);
      // Hard stop if anything still scans as a credential (shouldn't after redact).
      for (const ex of clean.examples) {
        const f = scanSecrets(`${ex.input}\n${typeof ex.output === 'string' ? ex.output : JSON.stringify(ex.output)}`);
        if (hasCredential(f)) die(`refusing to export: example still contains a credential (${f.map((x) => x.kind).join(', ')})`);
      }
      let body: string;
      let ext: string;
      if (format === 'openai') {
        body = toOpenAIChatJsonl(clean, flags.system ? { defaultSystem: flags.system } : {});
        ext = 'openai.jsonl';
      } else if (format === 'jsonl') {
        body = toJsonl(clean.examples);
        ext = 'jsonl';
      } else {
        body = toCsv(clean.examples);
        ext = 'csv';
      }
      const out = flags.out ?? path.join(dir, `${stem}.${ext}`);
      writeFileSync(out, body);
      log(`Exported ${clean.examples.length} example(s) as ${format} → ${out}`);
      break;
    }

    default:
      die(`unknown command "${cmd}". Use validate|sanitize|split|export.`);
  }
}

main();
