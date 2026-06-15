/**
 * Dedicated Python execution tool. It is always state-mutating and therefore
 * confirmation-gated. Python runs in isolated mode with a jailed working
 * directory, timeout, output cap, hidden window, and no inherited secrets.
 *
 * This is not an OS sandbox: approved Python can still access the network and
 * absolute paths. The gate and audit log are the security boundary.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export interface PythonToolOptions {
  workspaceDir: string;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export function createPythonTool(opts: PythonToolOptions): Tool {
  return defineTool({
    name: 'run_python',
    description:
      'Execute Python code for calculations, data processing, debugging, or file generation. ' +
      'Runs in isolated mode inside the ARES workspace and always requires action approval.',
    kind: 'state_mutating',
    schema: z.object({
      code: z
        .string()
        .describe('Complete Python program to execute. Print results that should be returned.'),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const code = String(input.code ?? '');
      if (!code.trim()) return { ok: false, content: 'No Python code provided.' };
      if (Buffer.byteLength(code, 'utf8') > 128 * 1024) {
        return { ok: false, content: 'Python program exceeds the 128 KB input limit.' };
      }
      await mkdir(opts.workspaceDir, { recursive: true });
      return runPython(code, opts, ctx);
    },
  });
}

function runPython(
  code: string,
  opts: PythonToolOptions,
  ctx: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    const child = spawn(opts.command, ['-I', '-c', code], {
      cwd: opts.workspaceDir,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        TEMP: process.env.TEMP ?? '',
        TMP: process.env.TMP ?? '',
      },
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        content: `Python timed out after ${opts.timeoutMs}ms and was killed.\n${render()}`,
        data: { timedOut: true },
      });
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ ok: false, content: 'Python execution aborted.', data: { aborted: true } });
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const capture = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      if (bytes >= opts.maxOutputBytes) {
        truncated = true;
        return;
      }
      const slice = chunk.subarray(0, opts.maxOutputBytes - bytes);
      bytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      if (target === 'stdout') stdout += slice.toString('utf8');
      else stderr += slice.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
    child.on('error', (error) => {
      finish({ ok: false, content: `Failed to start Python: ${error.message}` });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        content: render(code),
        data: { exitCode: code, truncated },
      });
    });

    function render(code?: number | null): string {
      const sections: string[] = [];
      if (code !== undefined && code !== null) sections.push(`exit code: ${code}`);
      if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
      if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
      if (truncated) sections.push(`(output truncated at ${opts.maxOutputBytes} bytes)`);
      return sections.join('\n') || '(no output)';
    }

    function finish(result: ToolResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
  });
}
