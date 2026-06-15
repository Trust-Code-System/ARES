/**
 * Remotion video generator (Phase: video).
 *
 * Scaffolds a complete, render-ready Remotion project into the workspace sandbox
 * from high-level props (title, scenes, colors, fps, audio) and returns the exact
 * install + render commands. It deliberately does NOT spawn the renderer itself:
 * `remotion render` needs node_modules + a headless Chromium and is a heavy,
 * long-running side effect, so it's surfaced as a command to run through the
 * gated, audited `run_command` tool — keeping video generation inside the same
 * confirmation/permission model as everything else. Writing the project files is
 * itself `state_mutating`, so this tool is gated too.
 *
 * LICENSING — Remotion is NOT unconditionally free. Individuals, non-profits, and
 * for-profit companies with up to 3 employees may use it for free (incl.
 * commercial videos); larger for-profit orgs require a paid company license from
 * remotion.pro. The scaffolder writes this warning into the project README and
 * returns it in the tool result so it is never silently ignored.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { createWorkspaceJail } from './jail.js';

export const REMOTION_LICENSE_WARNING =
  'Remotion is source-available but NOT unconditionally free for commercial use. ' +
  'Free for individuals, non-profits, and for-profit companies with <=3 employees ' +
  '(combined headcount across collaborating teams counts). Larger for-profit orgs ' +
  'need a paid company license from https://remotion.pro. Review the LICENSE before ' +
  'shipping commercially.';

const SceneSchema = z.object({
  text: z.string().describe('Headline text shown during this scene.'),
  durationInFrames: z
    .number()
    .int()
    .min(1)
    .max(3000)
    .describe('Frames this scene is on screen (default 90 = 3s at 30fps).')
    .optional(),
  image: z
    .string()
    .describe('Optional workspace-relative image path shown behind the scene text.')
    .optional(),
});

export function createRemotionTool(workspaceRoot: string): Tool {
  const { resolveInJail, assertRealPathInJail } = createWorkspaceJail(workspaceRoot);

  return defineTool({
    name: 'remotion_video_generator',
    description:
      'Scaffold a render-ready Remotion (React) video project in the workspace from ' +
      'high-level props: a title, a list of scenes (each with text and an optional ' +
      'image), colors, fps, and optional audio. Use this for promo clips, explainers, ' +
      'animated text videos, and social media videos. It writes the project files and ' +
      'returns the install + render commands to run via run_command — it does not ' +
      'render directly (rendering needs Chromium). Note the Remotion commercial ' +
      'license terms returned in the result.',
    kind: 'state_mutating',
    schema: z.object({
      projectDir: z
        .string()
        .describe('Workspace-relative directory to scaffold into (default "remotion-video").')
        .optional(),
      compositionId: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'must be a valid React component id')
        .describe('Composition id / component name (default "PromoVideo").')
        .optional(),
      title: z.string().describe('Main title shown in the opening scene.'),
      subtitle: z.string().describe('Optional subtitle under the title.').optional(),
      scenes: z
        .array(SceneSchema)
        .max(50)
        .describe('Ordered scenes after the title. Each is text + optional image.')
        .optional(),
      fps: z.number().int().min(1).max(120).describe('Frames per second (default 30).').optional(),
      width: z.number().int().min(16).max(7680).describe('Video width px (default 1920).').optional(),
      height: z.number().int().min(16).max(4320).describe('Video height px (default 1080).').optional(),
      backgroundColor: z.string().describe('CSS background color (default "#0B1020").').optional(),
      textColor: z.string().describe('CSS text color (default "#FFFFFF").').optional(),
      accentColor: z.string().describe('CSS accent color (default "#5B8DEF").').optional(),
      audio: z.string().describe('Optional workspace-relative audio file (mp3/wav).').optional(),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      const projectDir = input.projectDir ?? 'remotion-video';
      const compId = input.compositionId ?? 'PromoVideo';
      const fps = input.fps ?? 30;
      const width = input.width ?? 1920;
      const height = input.height ?? 1080;
      const bg = input.backgroundColor ?? '#0B1020';
      const fg = input.textColor ?? '#FFFFFF';
      const accent = input.accentColor ?? '#5B8DEF';
      const titleDuration = Math.round(fps * 3);
      const scenes = input.scenes ?? [];
      const sceneDurations = scenes.map((s) => s.durationInFrames ?? fps * 3);
      const totalFrames = titleDuration + sceneDurations.reduce((a, b) => a + b, 0);

      const root = resolveInJail(projectDir);
      await assertRealPathInJail(path.dirname(root));

      const files = buildProjectFiles({
        compId,
        fps,
        width,
        height,
        bg,
        fg,
        accent,
        title: input.title,
        ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
        scenes,
        sceneDurations,
        titleDuration,
        totalFrames,
        ...(input.audio !== undefined ? { audio: input.audio } : {}),
      });

      const written: string[] = [];
      for (const [rel, content] of Object.entries(files)) {
        const target = resolveInJail(path.join(projectDir, rel));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        written.push(path.join(projectDir, rel).split(path.sep).join('/'));
      }

      ctx.logger.info('remotion project scaffolded', {
        projectDir,
        compId,
        scenes: scenes.length,
        totalFrames,
      });

      const installCmd = `npm --prefix ${projectDir} install`;
      const previewCmd = `npm --prefix ${projectDir} run preview`;
      const renderCmd = `npm --prefix ${projectDir} run render`;

      return {
        ok: true,
        content:
          `Scaffolded Remotion project "${compId}" in ${projectDir}/ ` +
          `(${scenes.length + 1} scenes, ${totalFrames} frames @ ${fps}fps, ${width}x${height}).\n\n` +
          `Files:\n${written.map((f) => `  - ${f}`).join('\n')}\n\n` +
          `Next steps (run via run_command, which is gated):\n` +
          `  1. install: ${installCmd}\n` +
          `  2. preview: ${previewCmd}   (opens Remotion Studio)\n` +
          `  3. render:  ${renderCmd}    (writes out/${compId}.mp4)\n\n` +
          `⚠️ LICENSE: ${REMOTION_LICENSE_WARNING}`,
        data: {
          projectDir,
          compositionId: compId,
          files: written,
          totalFrames,
          fps,
          commands: { install: installCmd, preview: previewCmd, render: renderCmd },
          license: REMOTION_LICENSE_WARNING,
        },
      };
    },
  });
}

interface BuildArgs {
  compId: string;
  fps: number;
  width: number;
  height: number;
  bg: string;
  fg: string;
  accent: string;
  title: string;
  subtitle?: string;
  scenes: Array<z.infer<typeof SceneSchema>>;
  sceneDurations: number[];
  titleDuration: number;
  totalFrames: number;
  audio?: string;
}

/** Build the full set of project files keyed by project-relative path. */
function buildProjectFiles(a: BuildArgs): Record<string, string> {
  const j = (v: unknown): string => JSON.stringify(v);

  const packageJson = `${JSON.stringify(
    {
      name: a.compId.toLowerCase(),
      version: '1.0.0',
      private: true,
      scripts: {
        preview: 'remotion studio',
        render: `remotion render ${a.compId} out/${a.compId}.mp4`,
        upgrade: 'remotion upgrade',
      },
      dependencies: {
        '@remotion/cli': '^4.0.0',
        remotion: '^4.0.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
      devDependencies: {
        '@types/react': '^19.0.0',
        typescript: '^5.4.0',
      },
    },
    null,
    2,
  )}\n`;

  const tsconfig = `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        lib: ['ES2020', 'DOM'],
      },
    },
    null,
    2,
  )}\n`;

  const remotionConfig = `import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
`;

  const indexTs = `import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
`;

  const rootTsx = `import { Composition } from 'remotion';
import { ${a.compId}, schema } from './${a.compId}';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id=${j(a.compId)}
      component={${a.compId}}
      durationInFrames={${a.totalFrames}}
      fps={${a.fps}}
      width={${a.width}}
      height={${a.height}}
      schema={schema}
      defaultProps={{
        title: ${j(a.title)},
        subtitle: ${j(a.subtitle ?? '')},
      }}
    />
  );
};
`;

  // The scene sequence: a title card, then one Sequence per scene with a fade.
  const sceneBlocks = a.scenes
    .map((s, i) => {
      const from =
        a.titleDuration + a.sceneDurations.slice(0, i).reduce((x, y) => x + y, 0);
      const dur = a.sceneDurations[i];
      const img = s.image
        ? `      <Img src={staticFile(${j(s.image)})} style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35 }} />\n`
        : '';
      return `      <Sequence from={${from}} durationInFrames={${dur}}>
    <SceneCard>
${img}      <SceneText>${escapeJsxText(s.text)}</SceneText>
        </SceneCard>
      </Sequence>`;
    })
    .join('\n');

  const audioBlock = a.audio
    ? `      <Audio src={staticFile(${j(a.audio)})} />\n`
    : '';

  const compTsx = `import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  Audio,
  Img,
  staticFile,
  interpolate,
  useCurrentFrame,
  spring,
  useVideoConfig,
} from 'remotion';
import { z } from 'zod';

export const schema = z.object({
  title: z.string(),
  subtitle: z.string(),
});

const BG = ${j(a.bg)};
const FG = ${j(a.fg)};
const ACCENT = ${j(a.accent)};

const FadeIn: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  return <div style={{ opacity }}>{children}</div>;
};

const SceneCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: BG, justifyContent: 'center', alignItems: 'center' }}>
    <FadeIn>{children}</FadeIn>
  </AbsoluteFill>
);

const SceneText: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2 style={{ color: FG, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 72, fontWeight: 700, textAlign: 'center', maxWidth: '80%' }}>
    {children}
  </h2>
);

export const ${a.compId}: React.FC<z.infer<typeof schema>> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
${audioBlock}      <Sequence from={0} durationInFrames={${a.titleDuration}}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ transform: \`scale(\${scale})\`, textAlign: 'center' }}>
            <h1 style={{ color: FG, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 96, fontWeight: 800, margin: 0 }}>
              {title}
            </h1>
            {subtitle ? (
              <p style={{ color: ACCENT, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 40, marginTop: 16 }}>
                {subtitle}
              </p>
            ) : null}
          </div>
        </AbsoluteFill>
      </Sequence>
${sceneBlocks}
    </AbsoluteFill>
  );
};
`;

  const readme = `# ${a.compId} — Remotion video

Generated by ARES. ${a.scenes.length + 1} scenes, ${a.totalFrames} frames @ ${a.fps}fps, ${a.width}x${a.height}.

## Commands
\`\`\`bash
npm install        # install dependencies
npm run preview    # open Remotion Studio to preview/iterate
npm run render     # render to out/${a.compId}.mp4
\`\`\`

Put any images/audio referenced by scenes into a \`public/\` folder (Remotion's
\`staticFile\` resolves from there).

## ⚠️ License
${REMOTION_LICENSE_WARNING}
`;

  return {
    'package.json': packageJson,
    'tsconfig.json': tsconfig,
    'remotion.config.ts': remotionConfig,
    'src/index.ts': indexTs,
    'src/Root.tsx': rootTsx,
    [`src/${a.compId}.tsx`]: compTsx,
    'README.md': readme,
  };
}

/** Minimal JSX text escaping for braces that would otherwise open an expression. */
function escapeJsxText(text: string): string {
  return text.replace(/[{}]/g, (c) => `{'${c}'}`);
}
