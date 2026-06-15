/**
 * Vision text extraction (OCR) via the Anthropic Messages API.
 *
 * The document `extract_image_text` tool needs to turn an image (screenshot,
 * scanned page, photo of a whiteboard) into text. Rather than pulling in a heavy
 * native OCR engine, ARES asks Claude vision — it handles handwriting, tables,
 * and layout far better than classic OCR and needs no extra dependency.
 *
 * This is deliberately decoupled from the main {@link MessageClient}: the agent's
 * reasoning provider can be OpenAI or Gemini while OCR still uses Claude, as long
 * as an ANTHROPIC_API_KEY is present. If it isn't, the extractor is absent and the
 * tool simply isn't registered (mirroring how web_search is conditional).
 */

import Anthropic from '@anthropic-ai/sdk';

/** Anthropic-supported image media types for the vision API. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

export interface VisionExtractor {
  /**
   * Extract the text content of an image. `base64` is the raw image bytes,
   * base64-encoded; `instructions` optionally steers extraction (e.g. "only the
   * table"). Returns the model's transcription as plain text.
   */
  extractText(
    image: { base64: string; mediaType: SupportedImageMediaType },
    instructions?: string,
  ): Promise<string>;
}

export interface AnthropicVisionOptions {
  apiKey: string;
  /** Vision-capable model. Sonnet is accurate and cheap enough for OCR. */
  model: string;
  maxTokens?: number;
}

const DEFAULT_INSTRUCTION =
  'Transcribe ALL text visible in this image exactly, preserving reading order and ' +
  'table structure where present. Output only the transcribed text — no preamble, no ' +
  'commentary. If there is no legible text, reply exactly with "(no text detected)".';

export class AnthropicVisionExtractor implements VisionExtractor {
  private readonly sdk: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicVisionOptions) {
    this.sdk = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  async extractText(
    image: { base64: string; mediaType: SupportedImageMediaType },
    instructions?: string,
  ): Promise<string> {
    const message = await this.sdk.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // OCR is a perception task, not a reasoning one — disable thinking to keep
      // it fast and cheap.
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
            },
            { type: 'text', text: instructions?.trim() || DEFAULT_INSTRUCTION },
          ],
        },
      ],
    });

    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
}

/**
 * Build a vision extractor if an Anthropic key is available, else undefined.
 * Independent of the chosen reasoning provider so OCR always uses Claude vision.
 */
export function buildVisionExtractor(opts: {
  anthropicApiKey?: string;
  model: string;
}): VisionExtractor | undefined {
  if (!opts.anthropicApiKey) return undefined;
  return new AnthropicVisionExtractor({ apiKey: opts.anthropicApiKey, model: opts.model });
}

/** Map a file extension to a supported image media type, or undefined. */
export function imageMediaTypeForPath(filePath: string): SupportedImageMediaType | undefined {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return undefined;
  }
}
