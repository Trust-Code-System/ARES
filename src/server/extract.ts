/**
 * Extract text from a file uploaded through the chat UI (drag-and-drop / attach).
 *
 * Reuses the same library-backed extractors as the document *tools* (PDF, DOCX,
 * spreadsheet) plus Claude vision OCR for images, but operates on an in-memory buffer
 * instead of a workspace path — uploads never touch the sandbox. Plain-text formats are
 * decoded directly. The extracted text is returned to the client, which folds it into
 * the next chat turn as context.
 */

import {
  clampExtractedText,
  extractDocxText,
  extractPdfText,
  extractSpreadsheetCsv,
} from '../tools/builtin/documents.js';
import { imageMediaTypeForPath, type VisionExtractor } from '../llm/vision.js';

export interface ExtractedUpload {
  name: string;
  /** Coarse category, for the UI: 'pdf' | 'docx' | 'spreadsheet' | 'image' | 'text'. */
  kind: string;
  text: string;
  truncated: boolean;
}

/** Plain-text / source extensions we decode as UTF-8 directly. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.sh', '.sql', '.ini', '.toml', '.env',
]);

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export async function extractUpload(opts: {
  filename: string;
  buffer: Buffer;
  vision?: VisionExtractor;
}): Promise<ExtractedUpload> {
  const { filename, buffer, vision } = opts;
  const ext = extOf(filename);

  if (ext === '.pdf') {
    const { text } = await extractPdfText(buffer);
    const { content, truncated } = clampExtractedText(text || '(no extractable text — the PDF has no text layer)');
    return { name: filename, kind: 'pdf', text: content, truncated };
  }

  if (ext === '.docx') {
    const { text } = await extractDocxText(buffer);
    const { content, truncated } = clampExtractedText(text || '(no text content found in document)');
    return { name: filename, kind: 'docx', text: content, truncated };
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const result = await extractSpreadsheetCsv(buffer);
    if ('error' in result) throw new Error(result.error);
    const { content, truncated } = clampExtractedText(result.csv || '(sheet is empty)');
    return { name: filename, kind: 'spreadsheet', text: content, truncated };
  }

  const mediaType = imageMediaTypeForPath(filename);
  if (mediaType) {
    if (!vision) throw new Error('image OCR is unavailable (no Anthropic key configured)');
    const text = await vision.extractText({ base64: buffer.toString('base64'), mediaType });
    const { content, truncated } = clampExtractedText(text || '(no text detected)');
    return { name: filename, kind: 'image', text: content, truncated };
  }

  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    const { content, truncated } = clampExtractedText(buffer.toString('utf8'));
    return { name: filename, kind: 'text', text: content, truncated };
  }

  throw new Error(`unsupported file type "${ext}"`);
}
