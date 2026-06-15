/**
 * Document reader tools. Fully deterministic and offline:
 *   - read_spreadsheet runs a real round-trip (SheetJS writes a temp .xlsx, the
 *     tool reads it back).
 *   - extract_image_text uses a fake VisionExtractor — no network, no real OCR.
 *   - PDF/DOCX coverage focuses on registration, the shared jail, and error paths
 *     (a real binary fixture isn't needed to prove the jail + wiring hold).
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { createDocumentTools } from '../src/tools/builtin/documents.js';
import {
  buildVisionExtractor,
  imageMediaTypeForPath,
  type VisionExtractor,
} from '../src/llm/vision.js';
import type { Logger, Tool, ToolContext } from '../src/types.js';

const logger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger, runId: 'run-doc-test' };

// 1x1 transparent PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ares-docs-'));
}

/** Write a workbook to disk via buffer (SheetJS's ESM writeFile can't bind fs). */
async function writeWorkbook(file: string, wb: XLSX.WorkBook): Promise<void> {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  await writeFile(file, buf);
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

/** A VisionExtractor that records its call and returns canned text. */
function fakeVision(): VisionExtractor & { calls: Array<{ mediaType: string; instructions?: string }> } {
  const calls: Array<{ mediaType: string; instructions?: string }> = [];
  return {
    calls,
    async extractText(image, instructions) {
      calls.push({ mediaType: image.mediaType, ...(instructions ? { instructions } : {}) });
      assert.ok(image.base64.length > 0, 'expected non-empty base64 image data');
      return 'INVOICE #42\nTotal: $100';
    },
  };
}

describe('document tools — registration', () => {
  it('always registers pdf/docx/spreadsheet, all read_only', () => {
    const tools = createDocumentTools({ workspaceDir: '/tmp/x' });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['read_docx', 'read_pdf', 'read_spreadsheet']);
    for (const tool of tools) assert.equal(tool.kind, 'read_only');
  });

  it('registers extract_image_text only when a vision extractor is supplied', () => {
    const without = createDocumentTools({ workspaceDir: '/tmp/x' });
    assert.ok(!without.some((t) => t.name === 'extract_image_text'));

    const withVision = createDocumentTools({ workspaceDir: '/tmp/x', vision: fakeVision() });
    const ocr = byName(withVision, 'extract_image_text');
    assert.equal(ocr.kind, 'read_only');
  });
});

describe('read_spreadsheet — real round-trip', () => {
  it('reads the first sheet as CSV', async () => {
    const dir = await workspace();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['name', 'amount'],
      ['Acme', 100],
      ['Globex', 250],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    await writeWorkbook(path.join(dir, 'book.xlsx'), wb);

    const tool = byName(createDocumentTools({ workspaceDir: dir }), 'read_spreadsheet');
    const result = await tool.execute({ path: 'book.xlsx' }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /name,amount/);
    assert.match(result.content, /Acme,100/);
    assert.match(result.content, /Globex,250/);
  });

  it('selects a named sheet and errors clearly on an unknown one', async () => {
    const dir = await workspace();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a']]), 'First');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['z']]), 'Second');
    await writeWorkbook(path.join(dir, 'multi.xlsx'), wb);

    const tool = byName(createDocumentTools({ workspaceDir: dir }), 'read_spreadsheet');

    const second = await tool.execute({ path: 'multi.xlsx', sheet: 'Second' }, ctx);
    assert.equal(second.ok, true);
    assert.match(second.content, /^z/);

    const missing = await tool.execute({ path: 'multi.xlsx', sheet: 'Nope' }, ctx);
    assert.equal(missing.ok, false);
    assert.match(missing.content, /no sheet named "Nope"/);
    assert.match(missing.content, /First, Second/);
  });
});

describe('extract_image_text — OCR via injected vision', () => {
  it('base64-encodes the image and returns the extractor text', async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, 'shot.png'), Buffer.from(TINY_PNG_B64, 'base64'));

    const vision = fakeVision();
    const tool = byName(createDocumentTools({ workspaceDir: dir, vision }), 'extract_image_text');
    const result = await tool.execute({ path: 'shot.png', instructions: 'read the total' }, ctx);

    assert.equal(result.ok, true);
    assert.match(result.content, /INVOICE #42/);
    assert.equal(vision.calls.length, 1);
    assert.equal(vision.calls[0]!.mediaType, 'image/png');
    assert.equal(vision.calls[0]!.instructions, 'read the total');
  });

  it('rejects unsupported image extensions before calling vision', async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, 'doc.bmp'), Buffer.from(TINY_PNG_B64, 'base64'));

    const vision = fakeVision();
    const tool = byName(createDocumentTools({ workspaceDir: dir, vision }), 'extract_image_text');
    const result = await tool.execute({ path: 'doc.bmp' }, ctx);

    assert.equal(result.ok, false);
    assert.match(result.content, /unsupported image type/);
    assert.equal(vision.calls.length, 0);
  });
});

describe('document tools — shared workspace jail', () => {
  it('rejects paths that escape the sandbox for every tool', async () => {
    const dir = await workspace();
    const tools = createDocumentTools({ workspaceDir: dir, vision: fakeVision() });
    // A valid image extension so the OCR tool's format check passes and the jail
    // (in readBytes) is the thing that rejects it — same boundary every tool hits.
    for (const tool of tools) {
      await assert.rejects(
        () => tool.execute({ path: '../../outside.png' }, ctx),
        /escapes the workspace sandbox/,
        `${tool.name} should reject jail escape`,
      );
    }
  });
});

describe('vision helpers', () => {
  it('maps extensions to media types', () => {
    assert.equal(imageMediaTypeForPath('a.PNG'), 'image/png');
    assert.equal(imageMediaTypeForPath('b.jpeg'), 'image/jpeg');
    assert.equal(imageMediaTypeForPath('c.jpg'), 'image/jpeg');
    assert.equal(imageMediaTypeForPath('d.webp'), 'image/webp');
    assert.equal(imageMediaTypeForPath('e.gif'), 'image/gif');
    assert.equal(imageMediaTypeForPath('f.txt'), undefined);
  });

  it('builds an extractor only when an Anthropic key is present', () => {
    assert.equal(buildVisionExtractor({ model: 'claude-sonnet-4-6' }), undefined);
    assert.ok(buildVisionExtractor({ anthropicApiKey: 'sk-test', model: 'claude-sonnet-4-6' }));
  });
});
