/**
 * Sandboxed workspace file tools: read_file, write_file, list_files.
 *
 * Every path is resolved against a single workspace root and rejected if it
 * escapes it (`..`, absolute paths, symlink traversal out of the jail). This is
 * the code-level boundary that keeps ARES's file access inside a known sandbox —
 * not a prompt instruction. Writes are `state_mutating` and therefore gated;
 * reads are free.
 *
 * Built via a factory because the tools close over the (config-supplied)
 * workspace root.
 */

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { createWorkspaceJail } from './jail.js';

const MAX_READ_BYTES = 256 * 1024; // 256 KB — enough for code/text, bounded for context.

export function createFileTools(workspaceRoot: string): Tool[] {
  const { resolveInJail, assertRealPathInJail } = createWorkspaceJail(workspaceRoot);

  const readTool = defineTool({
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the workspace sandbox. Paths are relative to the ' +
      'workspace root; paths that escape it are rejected. Use list_files first to discover paths.',
    kind: 'read_only',
    schema: z.object({ path: z.string().describe('Workspace-relative file path.') }),
    async execute(input): Promise<ToolResult> {
      const target = resolveInJail(input.path);
      await assertRealPathInJail(target);
      const info = await stat(target);
      if (info.size > MAX_READ_BYTES) {
        return { ok: false, content: `File is ${info.size} bytes; the ${MAX_READ_BYTES}-byte read limit was exceeded.` };
      }
      const content = await readFile(target, 'utf8');
      return { ok: true, content, data: { path: input.path, bytes: info.size } };
    },
  });

  const writeTool = defineTool({
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file in the workspace sandbox (parent ' +
      'directories are created as needed). This mutates the filesystem, so it is gated.',
    kind: 'state_mutating',
    schema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      content: z.string().describe('Full file contents to write.'),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const target = resolveInJail(input.path);
      await assertRealPathInJail(path.dirname(target));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content, 'utf8');
      ctx.logger.info('file written', { path: input.path, bytes: Buffer.byteLength(input.content) });
      return {
        ok: true,
        content: `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}.`,
        data: { path: input.path },
      };
    },
  });

  const listTool = defineTool({
    name: 'list_files',
    description:
      'List the entries of a directory in the workspace sandbox. Defaults to the ' +
      'workspace root. Returns names with a trailing "/" for directories.',
    kind: 'read_only',
    schema: z.object({
      path: z.string().describe('Workspace-relative directory (default: root).').optional(),
    }),
    async execute(input): Promise<ToolResult> {
      const target = resolveInJail(input.path ?? '.');
      await assertRealPathInJail(target);
      const entries = await readdir(target, { withFileTypes: true });
      if (entries.length === 0) return { ok: true, content: '(empty directory)' };
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join('\n');
      return { ok: true, content: lines, data: { count: entries.length } };
    },
  });

  return [readTool, writeTool, listTool];
}
