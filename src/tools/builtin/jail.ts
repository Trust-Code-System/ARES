/**
 * The workspace path jail — shared by every tool that touches the filesystem.
 *
 * This is the single code-level boundary that keeps ARES's file access inside a
 * known sandbox (never a prompt instruction). It rejects paths that escape the
 * root lexically (`..`, absolute paths) and paths whose resolved real target
 * escapes via a symlink. Both the text file tools (files.ts) and the document
 * reader tools (documents.ts) build on it, so the rule is identical everywhere
 * and lives in exactly one place.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceJail {
  /** Absolute, resolved workspace root. */
  readonly root: string;
  /** Resolve a user-supplied path inside the jail, or throw if it escapes. */
  resolveInJail(userPath: string): string;
  /** Throw if `target`'s resolved real path (following symlinks) escapes the jail. */
  assertRealPathInJail(target: string): Promise<void>;
}

export function createWorkspaceJail(workspaceRoot: string): WorkspaceJail {
  const root = path.resolve(workspaceRoot);

  const escapes = (rel: string): boolean =>
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

  const resolveInJail = (userPath: string): string => {
    const target = path.resolve(root, userPath);
    if (escapes(path.relative(root, target))) {
      throw new Error(`path "${userPath}" escapes the workspace sandbox`);
    }
    return target;
  };

  const assertRealPathInJail = async (target: string): Promise<void> => {
    try {
      const real = await realpath(target);
      if (escapes(path.relative(root, real))) {
        throw new Error('resolved real path escapes the workspace sandbox');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Not yet created (e.g. a write target) — the lexical check already covered it.
    }
  };

  return { root, resolveInJail, assertRealPathInJail };
}
