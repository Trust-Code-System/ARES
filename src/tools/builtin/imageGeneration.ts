/**
 * generate_image — render an image from a text prompt into the workspace.
 *
 * State-mutating: it both spends money (a paid image model) and writes a file,
 * so it routes through the confirmation gate and audit log like every other
 * write, and its cost can be bounded by the spend caps. The bytes land inside
 * the same workspace jail the file tools use — never outside the sandbox.
 *
 * Registered only when an {@link ImageGenerator} is configured (a provider key
 * is present), mirroring how web_search / extract_image_text stay conditional.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { createWorkspaceJail } from './jail.js';
import type { ImageGenerator } from '../../llm/imageGen.js';

const EXT_FOR_MEDIA: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function createImageGenerationTool(
  generator: ImageGenerator,
  workspaceDir: string,
): ReturnType<typeof defineTool> {
  const { resolveInJail, assertRealPathInJail } = createWorkspaceJail(workspaceDir);

  return defineTool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt and save it into the workspace. Use when ' +
      'the user wants an actual picture/illustration/diagram rendered (not just a ' +
      'prompt or design direction). Returns the saved file path. State-mutating: it ' +
      'is gated and costs money.',
    kind: 'state_mutating',
    schema: z.object({
      prompt: z.string().min(1).describe('What to render. Be specific and descriptive.'),
      filename: z
        .string()
        .describe('Output filename inside the workspace (e.g. "hero.png"). Defaults to a timestamped name.')
        .optional(),
      size: z
        .string()
        .describe('Pixel size like "1024x1024", "1024x1536" (portrait), or "1536x1024" (landscape).')
        .optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const image = await generator.generate({
        prompt: input.prompt,
        ...(input.size ? { size: input.size } : {}),
      });

      const ext = EXT_FOR_MEDIA[image.mediaType] ?? 'png';
      const requested = input.filename?.trim() || `image-${Date.now()}.${ext}`;
      // Force the extension to match what the model actually returned.
      const named = ensureExtension(requested, ext);

      const target = resolveInJail(named);
      await assertRealPathInJail(target);
      await writeFile(target, Buffer.from(image.base64, 'base64'));

      const rel = path.relative(workspaceDir, target);
      ctx.logger.info('image generated', { provider: generator.provider, model: generator.model, file: rel });
      return {
        ok: true,
        content: `Saved generated image to ${rel} (${generator.provider}/${generator.model}).`,
        data: { file: rel, provider: generator.provider, model: generator.model, mediaType: image.mediaType },
      };
    },
  });
}

/** Replace/append the file extension so it matches the returned media type. */
function ensureExtension(name: string, ext: string): string {
  const current = path.extname(name).toLowerCase().replace(/^\./, '');
  if (current === ext || (current === 'jpeg' && ext === 'jpg')) return name;
  const base = current ? name.slice(0, name.length - current.length - 1) : name;
  return `${base}.${ext}`;
}
