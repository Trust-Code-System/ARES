/**
 * Sandboxed document reader tools: read_pdf, read_docx, read_spreadsheet,
 * extract_image_text.
 *
 * These extend ARES from plain UTF-8 files (files.ts) to the document formats a
 * principal actually works with — PDFs, Word docs, spreadsheets, and screenshots.
 * Every path goes through the same {@link createWorkspaceJail} boundary the text
 * tools use, so they can only read inside the workspace sandbox. All four are
 * `read_only` (they observe, never mutate), so they run without confirmation.
 *
 * Built via a factory because they close over the workspace root and (for OCR)
 * the optional Claude {@link VisionExtractor}.
 */

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { createWorkspaceJail } from './jail.js';
import { imageMediaTypeForPath, type VisionExtractor } from '../../llm/vision.js';

/** Binary docs can be large; cap the bytes we load and the text we return. */
const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB on disk
const MAX_OUTPUT_CHARS = 200 * 1024; // ~200 KB of extracted text, to bound context
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Anthropic vision input ceiling (~before base64)

export interface DocumentToolsOptions {
  workspaceDir: string;
  /** When present, `extract_image_text` is registered. Absent → image OCR is unavailable. */
  vision?: VisionExtractor;
}

export function createDocumentTools(opts: DocumentToolsOptions): Tool[] {
  const { resolveInJail, assertRealPathInJail } = createWorkspaceJail(opts.workspaceDir);

  /** Resolve + jail-check a path and read it as raw bytes, enforcing the size cap. */
  const readBytes = async (userPath: string): Promise<Buffer> => {
    const target = resolveInJail(userPath);
    await assertRealPathInJail(target);
    const info = await stat(target);
    if (info.size > MAX_DOC_BYTES) {
      throw new Error(`file is ${info.size} bytes; the ${MAX_DOC_BYTES}-byte document limit was exceeded`);
    }
    return readFile(target);
  };

  const tools: Tool[] = [
    pdfTool(readBytes),
    docxTool(readBytes),
    spreadsheetTool(readBytes),
  ];

  if (opts.vision) tools.push(imageTool(readBytes, opts.vision));

  return tools;
}

/** Truncate extracted text to the output cap, with a clear marker. */
function clamp(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { content: text, truncated: false };
  return {
    content: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[...truncated: extracted text exceeded ${MAX_OUTPUT_CHARS} characters]`,
    truncated: true,
  };
}

function pdfTool(readBytes: (p: string) => Promise<Buffer>): Tool {
  return defineTool({
    name: 'read_pdf',
    description:
      'Extract the text of a PDF file from the workspace sandbox. Returns the document text ' +
      '(concatenated across pages). Paths are workspace-relative; paths that escape are rejected. ' +
      'Use for reports, contracts, papers, and scanned PDFs that contain a text layer.',
    kind: 'read_only',
    schema: z.object({ path: z.string().describe('Workspace-relative path to a .pdf file.') }),
    async execute(input): Promise<ToolResult> {
      const buf = await readBytes(input.path);
      // pdf-parse v2: dynamic import so its pdfjs dependency loads only when used.
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const result = await parser.getText();
        const pageCount = result.pages.length;
        const text = result.text.trim();
        if (!text) {
          return {
            ok: true,
            content:
              '(no extractable text — the PDF has no text layer. If it is a scan, render a page to ' +
              'an image and use extract_image_text instead.)',
            data: { path: input.path, pages: pageCount, empty: true },
          };
        }
        const { content, truncated } = clamp(text);
        return { ok: true, content, data: { path: input.path, pages: pageCount, truncated } };
      } finally {
        await parser.destroy();
      }
    },
  });
}

function docxTool(readBytes: (p: string) => Promise<Buffer>): Tool {
  return defineTool({
    name: 'read_docx',
    description:
      'Extract the text of a Microsoft Word .docx file from the workspace sandbox. ' +
      'Returns the document body as plain text. Paths are workspace-relative; escapes are rejected.',
    kind: 'read_only',
    schema: z.object({ path: z.string().describe('Workspace-relative path to a .docx file.') }),
    async execute(input): Promise<ToolResult> {
      const buf = await readBytes(input.path);
      const mammoth = await import('mammoth');
      const { value, messages } = await mammoth.extractRawText({ buffer: buf });
      const text = value.trim();
      if (!text) {
        return { ok: true, content: '(no text content found in document)', data: { path: input.path, empty: true } };
      }
      const { content, truncated } = clamp(text);
      return {
        ok: true,
        content,
        data: { path: input.path, truncated, warnings: messages.map((m) => m.message) },
      };
    },
  });
}

function spreadsheetTool(readBytes: (p: string) => Promise<Buffer>): Tool {
  return defineTool({
    name: 'read_spreadsheet',
    description:
      'Read a spreadsheet (.xlsx, .xls, .csv) from the workspace sandbox and return its cells ' +
      'as CSV text. Reads the first sheet by default; pass `sheet` to choose another by name. ' +
      'Paths are workspace-relative; escapes are rejected.',
    kind: 'read_only',
    schema: z.object({
      path: z.string().describe('Workspace-relative path to a .xlsx/.xls/.csv file.'),
      sheet: z.string().describe('Optional sheet name (default: the first sheet).').optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const buf = await readBytes(input.path);
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetNames = wb.SheetNames;
      if (sheetNames.length === 0) {
        return { ok: false, content: 'workbook contains no sheets' };
      }
      const target = input.sheet ?? sheetNames[0]!;
      const ws = wb.Sheets[target];
      if (!ws) {
        return {
          ok: false,
          content: `no sheet named "${target}". Available sheets: ${sheetNames.join(', ')}.`,
        };
      }
      const csv = XLSX.utils.sheet_to_csv(ws).trim();
      if (!csv) {
        return { ok: true, content: '(sheet is empty)', data: { path: input.path, sheet: target, sheets: sheetNames } };
      }
      const { content, truncated } = clamp(csv);
      return {
        ok: true,
        content,
        data: { path: input.path, sheet: target, sheets: sheetNames, truncated },
      };
    },
  });
}

function imageTool(
  readBytes: (p: string) => Promise<Buffer>,
  vision: VisionExtractor,
): Tool {
  return defineTool({
    name: 'extract_image_text',
    description:
      'Extract text from an image or screenshot (.png, .jpg, .jpeg, .gif, .webp) in the workspace ' +
      'sandbox using vision OCR. Handles screenshots, photos of documents, handwriting, and tables. ' +
      'Optionally pass `instructions` to focus on part of the image. Paths are workspace-relative.',
    kind: 'read_only',
    schema: z.object({
      path: z.string().describe('Workspace-relative path to an image file.'),
      instructions: z
        .string()
        .describe('Optional steering, e.g. "only transcribe the table" or "read the error dialog".')
        .optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const mediaType = imageMediaTypeForPath(input.path);
      if (!mediaType) {
        return {
          ok: false,
          content: `unsupported image type for "${input.path}". Supported: .png, .jpg, .jpeg, .gif, .webp.`,
        };
      }
      const buf = await readBytes(input.path);
      if (buf.length > MAX_IMAGE_BYTES) {
        return { ok: false, content: `image is ${buf.length} bytes; the ${MAX_IMAGE_BYTES}-byte OCR limit was exceeded` };
      }
      const text = await vision.extractText(
        { base64: buf.toString('base64'), mediaType },
        input.instructions,
      );
      const { content, truncated } = clamp(text || '(no text detected)');
      return { ok: true, content, data: { path: input.path, truncated } };
    },
  });
}
