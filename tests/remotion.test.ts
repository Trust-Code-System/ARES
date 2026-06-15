/**
 * Remotion video scaffolder — offline. Scaffolds into a temp workspace and
 * verifies the project files, prop wiring, duration math, jail enforcement, and
 * that the licensing warning is always surfaced.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemotionTool, REMOTION_LICENSE_WARNING } from '../src/tools/builtin/remotion.js';
import type { Logger, ToolContext } from '../src/types.js';

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger: silentLogger, runId: 'test' };

describe('remotion_video_generator', () => {
  it('scaffolds a render-ready project and computes total duration', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ares-remotion-'));
    try {
      const tool = createRemotionTool(ws);
      const res = await tool.execute(
        {
          title: 'Launch Day',
          subtitle: 'v2 is here',
          fps: 30,
          scenes: [
            { text: 'Faster' },
            { text: 'Cheaper', durationInFrames: 60 },
          ],
        },
        ctx,
      );
      assert.equal(res.ok, true);

      const dir = path.join(ws, 'remotion-video');
      for (const f of ['package.json', 'tsconfig.json', 'remotion.config.ts', 'src/index.ts', 'src/Root.tsx', 'src/PromoVideo.tsx', 'README.md']) {
        assert.ok(existsSync(path.join(dir, f)), `missing ${f}`);
      }

      // Duration = title(90) + scene1(90 default) + scene2(60) = 240.
      const root = readFileSync(path.join(dir, 'src/Root.tsx'), 'utf8');
      assert.match(root, /durationInFrames=\{240\}/);
      assert.match(root, /fps=\{30\}/);

      // Title prop is wired into defaultProps; scene text into the composition.
      assert.match(root, /Launch Day/);
      const comp = readFileSync(path.join(dir, 'src/PromoVideo.tsx'), 'utf8');
      assert.match(comp, /Faster/);
      assert.match(comp, /Cheaper/);

      // The render command and license warning are always surfaced.
      const data = res.data as { commands: { render: string }; license: string };
      assert.match(data.commands.render, /run render/);
      assert.equal(data.license, REMOTION_LICENSE_WARNING);
      assert.match(res.content, /LICENSE/);
      // package.json carries the actual remotion render script.
      const pkg = readFileSync(path.join(dir, 'package.json'), 'utf8');
      assert.match(pkg, /remotion render PromoVideo/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects a projectDir that escapes the workspace jail', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ares-remotion-'));
    try {
      const tool = createRemotionTool(ws);
      await assert.rejects(
        tool.execute({ title: 'x', projectDir: '../escape' }, ctx),
        /escapes the workspace sandbox/,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('is a gated state-mutating tool', () => {
    const tool = createRemotionTool('/tmp');
    assert.equal(tool.kind, 'state_mutating');
    assert.equal(tool.name, 'remotion_video_generator');
  });
});
