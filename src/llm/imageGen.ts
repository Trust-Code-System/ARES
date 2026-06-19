/**
 * Native image generation.
 *
 * ARES historically declared image generation an *external* boundary — it could
 * direct and prompt, but not produce a picture. This closes that gap by routing
 * to a real image model (OpenAI Images or Gemini) behind a provider-agnostic
 * {@link ImageGenerator}. Like voice, it speaks only this interface, so the
 * `generate_image` tool neither knows nor cares which provider is behind it, and
 * it stays opt-in: no key → no generator → the tool isn't registered.
 */

import { redactSensitiveText } from '../security/redactor.js';

export interface GeneratedImage {
  /** Raw image bytes, base64-encoded. */
  base64: string;
  /** e.g. `image/png`. */
  mediaType: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  /** Square/portrait/landscape hint, e.g. `1024x1024`. Provider clamps as needed. */
  size?: string;
}

export interface ImageGenerator {
  readonly provider: string;
  readonly model: string;
  generate(req: ImageGenerationRequest): Promise<GeneratedImage>;
}

const DEFAULT_SIZE = '1024x1024';

export interface OpenAiImageOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** OpenAI Images (gpt-image-1): returns base64 PNG by default. */
export class OpenAiImageGenerator implements ImageGenerator {
  readonly provider = 'openai';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiImageOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-image-1';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ImageGenerationRequest): Promise<GeneratedImage> {
    const res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: redactSensitiveText(req.prompt),
        size: req.size ?? DEFAULT_SIZE,
        n: 1,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI image generation failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI returned no image data.');
    return { base64: b64, mediaType: 'image/png' };
  }
}

export interface GeminiImageOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Gemini image generation via generateContent with an IMAGE response modality. */
export class GeminiImageGenerator implements ImageGenerator {
  readonly provider = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiImageOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gemini-2.5-flash-image';
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ImageGenerationRequest): Promise<GeneratedImage> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: redactSensitiveText(req.prompt) }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini image generation failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    };
    const part = (json.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    const data = part?.inlineData?.data;
    if (!data) throw new Error('Gemini returned no image data.');
    return { base64: data, mediaType: part?.inlineData?.mimeType ?? 'image/png' };
  }
}

/**
 * Build an image generator from the environment, or undefined when no provider
 * is available. `ARES_IMAGE_PROVIDER` (auto|openai|gemini) selects; `auto`
 * prefers OpenAI (gpt-image-1 renders in-image text well) then Gemini.
 */
export function buildImageGenerator(env: NodeJS.ProcessEnv = process.env): ImageGenerator | undefined {
  const choice = (env.ARES_IMAGE_PROVIDER ?? 'auto').toLowerCase();
  const openaiKey = env.OPENAI_API_KEY;
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const model = env.ARES_IMAGE_MODEL;

  const openai = (): ImageGenerator | undefined =>
    openaiKey
      ? new OpenAiImageGenerator({
          apiKey: openaiKey,
          ...(model ? { model } : {}),
          ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
        })
      : undefined;
  const gemini = (): ImageGenerator | undefined =>
    geminiKey ? new GeminiImageGenerator({ apiKey: geminiKey, ...(model ? { model } : {}) }) : undefined;

  if (choice === 'openai') return openai();
  if (choice === 'gemini') return gemini();
  return openai() ?? gemini();
}
