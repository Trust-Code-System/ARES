/**
 * Dataset pipeline tests — validation, dedupe, deterministic split, export.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Dataset } from '../src/ai-training/types.js';
import { validateDataset } from '../src/ai-training/validate.js';
import { dedupeExamples, splitDataset, sanitizeDataset } from '../src/ai-training/dataset.js';
import { toOpenAIChatJsonl, toCsv } from '../src/ai-training/export.js';

const file = path.resolve(process.cwd(), 'ai-training/datasets/jarvis-routing.v1.json');
const dataset = JSON.parse(readFileSync(file, 'utf8')) as Dataset;

describe('dataset: validation', () => {
  it('the shipped sample validates with no errors', () => {
    const report = validateDataset(dataset);
    assert.equal(report.errors, 0, JSON.stringify(report.issues));
    assert.ok(report.ok);
  });

  it('flags a hard credential as an error', () => {
    const bad: Dataset = {
      name: 'x', version: '1', examples: [{ input: 'use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', output: 'ok' }],
    };
    const report = validateDataset(bad);
    assert.equal(report.ok, false);
    assert.ok(report.errors >= 1);
  });

  it('flags duplicate inputs as warnings', () => {
    const dup: Dataset = {
      name: 'x', version: '1',
      examples: [{ input: 'hello', output: 'a' }, { input: 'Hello', output: 'b' }],
    };
    const report = validateDataset(dup);
    assert.ok(report.warnings >= 1);
  });
});

describe('dataset: dedupe + split', () => {
  it('dedupes by case-insensitive input', () => {
    const out = dedupeExamples([{ input: 'A', output: '1' }, { input: 'a', output: '2' }]);
    assert.equal(out.length, 1);
  });

  it('split is deterministic and partitions every example', () => {
    const a = splitDataset(dataset.examples, { seed: dataset.name });
    const b = splitDataset(dataset.examples, { seed: dataset.name });
    assert.deepEqual(a.train.map((e) => e.input), b.train.map((e) => e.input));
    const total = a.train.length + a.validation.length + a.test.length;
    assert.equal(total, dataset.examples.length);
  });

  it('rejects an invalid split ratio', () => {
    assert.throws(() => splitDataset(dataset.examples, { trainFrac: 0.9, valFrac: 0.2 }));
  });
});

describe('dataset: export', () => {
  it('OpenAI JSONL produces one valid messages object per example', () => {
    const lines = toOpenAIChatJsonl(dataset, { defaultSystem: 'sys' }).split('\n');
    assert.equal(lines.length, dataset.examples.length);
    const first = JSON.parse(lines[0]!);
    assert.ok(Array.isArray(first.messages));
    assert.equal(first.messages[0].role, 'system');
    assert.equal(first.messages.at(-1).role, 'assistant');
    // Object output is serialized to JSON string.
    assert.doesNotThrow(() => JSON.parse(first.messages.at(-1).content));
  });

  it('CSV has the input,output header', () => {
    assert.ok(toCsv(dataset.examples).startsWith('input,output\n'));
  });

  it('sanitizeDataset redacts a planted secret', () => {
    const planted: Dataset = {
      name: 'x', version: '1',
      examples: [{ input: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', output: { note: 'mail me a@b.com' } }],
    };
    const { dataset: clean, redactedCount } = sanitizeDataset(planted);
    assert.equal(redactedCount, 1);
    assert.ok(!JSON.stringify(clean).includes('sk-ant-'));
    assert.ok(!JSON.stringify(clean).includes('a@b.com'));
  });
});
