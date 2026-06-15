/**
 * run_command — execute an allowlisted program inside the workspace sandbox.
 *
 * This is the highest-risk tool in ARES, so it is deliberately conservative and
 * OFF BY DEFAULT (enabled only when `ARES_SHELL_ENABLED=true`):
 *   - state-mutating → always routed through the confirmation gate.
 *   - DENY-BY-DEFAULT allowlist: only bare program names on the allowlist run; a
 *     program with a path separator or not on the list is refused.
 *   - NO SHELL: spawned with `shell:false` and an explicit argv, so there is no
 *     shell metacharacter interpretation (no `;`, `|`, `$()`, globbing, redirects).
 *   - jailed cwd: runs in `ARES_WORKSPACE_DIR`.
 *   - hard timeout (SIGKILL) and cooperative abort via ctx.signal.
 *   - output capped to a byte budget.
 *
 * Residual risk worth stating: an allowlisted program can still read/write paths
 * passed as arguments outside the workspace (we sandbox the cwd, not the program's
 * syscalls). Keep the allowlist tight; this is not a security boundary against a
 * hostile allowlisted binary.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export interface ShellToolOptions {
  workspaceDir: string;
  allowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export function createShellTool(opts: ShellToolOptions): Tool {
  const allowlist = new Set(opts.allowlist);

  return defineTool({
    name: 'run_command',
    description:
      'Run an allowlisted command-line program inside the workspace sandbox and return its ' +
      'output. Provide the program as `command` (a bare name, e.g. "git") and its arguments ' +
      `as an array in \`args\` (no shell syntax — pipes/redirects/globs are not interpreted). ` +
      `Allowed programs: ${opts.allowlist.join(', ')}.`,
    kind: 'state_mutating',
    schema: z.object({
      command: z.string().describe('Bare program name (must be allowlisted).'),
      args: z.array(z.string()).describe('Arguments, one per element.').optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const program = String(input.command ?? '').trim();
      const args = Array.isArray(input.args) ? input.args.map(String) : [];

      if (!program) return { ok: false, content: 'No command provided.' };
      if (/[\\/]/.test(program) || program.includes('..')) {
        return { ok: false, content: 'Command must be a bare program name (no path separators).' };
      }
      if (!allowlist.has(program)) {
        return {
          ok: false,
          content: `Command "${program}" is not allowlisted. Allowed: ${[...allowlist].join(', ')}.`,
        };
      }
      return runProcess(program, args, opts, ctx);
    },
  });
}

function runProcess(
  program: string,
  args: string[],
  opts: ShellToolOptions,
  ctx: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;

    const child = spawn(program, args, {
      cwd: opts.workspaceDir,
      shell: false,
      windowsHide: true,
      // Pass a minimal environment — PATH so the program resolves, nothing secret.
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        content: `Command timed out after ${opts.timeoutMs}ms and was killed.\n${render()}`,
        data: { program, timedOut: true },
      });
    }, opts.timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ ok: false, content: 'Command aborted.', data: { program, aborted: true } });
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const capture = (chunk: Buffer, into: 'out' | 'err') => {
      if (bytes >= opts.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = opts.maxOutputBytes - bytes;
      const slice = chunk.subarray(0, remaining);
      bytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      if (into === 'out') stdout += slice.toString('utf8');
      else stderr += slice.toString('utf8');
    };

    child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

    child.on('error', (err) => {
      finish({ ok: false, content: `Failed to start "${program}": ${err.message}`, data: { program } });
    });

    child.on('close', (code) => {
      finish({
        ok: code === 0,
        content: render(code),
        data: { program, exitCode: code, truncated },
      });
    });

    function render(code?: number | null): string {
      const parts: string[] = [];
      if (code !== undefined && code !== null) parts.push(`exit code: ${code}`);
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
      if (truncated) parts.push(`(output truncated at ${opts.maxOutputBytes} bytes)`);
      return parts.join('\n') || '(no output)';
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

export const DEFAULT_SHELL_ALLOWLIST = [
  'node', 'npm', 'npx', 'git', 'ls', 'cat', 'echo', 'pwd', 'rg', 'grep', 'sed', 'awk', 'python', 'python3',
];
