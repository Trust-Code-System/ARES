---
name: remotion
description: Generate videos programmatically with Remotion (React-based). Use when asked to create a promo video, explainer, animated text/social clip, or any short rendered video. Explains when to reach for the remotion_video_generator tool and how to drive it.
---

# Remotion Video Generation

Remotion renders videos from React components, so a video becomes code: parameterized,
versionable, and re-renderable. ARES drives it through the **`remotion_video_generator`**
tool, which scaffolds a render-ready project from high-level props.

## When to use
- Promo / launch videos, explainers, animated text, social clips (square/vertical/landscape).
- Any video where the content is data (title + scenes + colors + audio) rather than
  hand-edited footage.
- Pair with marketing skills (script/copy) for promos: write the script first, then generate.

## When NOT to use
- Editing existing real footage, complex VFX, or live-action — Remotion is for generated/
  motion-graphics video, not a video editor.
- When the user/company is a for-profit org with >3 employees and has no Remotion company
  license — see licensing below; surface this before generating commercial output.

## Required inputs
- `title` (required) and optional `subtitle`.
- `scenes`: ordered list, each `{ text, durationInFrames?, image? }`.
- Optional styling: `fps` (default 30), `width`/`height` (default 1920×1080 — use 1080×1920
  for vertical/Reels, 1080×1080 for square), `backgroundColor`, `textColor`, `accentColor`.
- Optional `audio` (workspace-relative). Put referenced images/audio in the project's
  `public/` folder so Remotion's `staticFile` resolves them.

## Process
1. If it's a promo, draft/confirm the script and scene breakdown first (1 idea per scene).
2. Choose dimensions for the target platform and a duration per scene (~3s = 90 frames @30fps).
3. Call `remotion_video_generator` with title + scenes + colors. It writes the project and
   returns the install/preview/render commands. (The call is gated — it writes files.)
4. To actually render, run the returned `render` command through `run_command` (gated, and
   it needs dependencies installed + a headless Chromium). Preview with `npm run preview`.
5. Report the output path (`out/<Composition>.mp4`) and the license note.

## Output format
Confirm the scene plan, then the generated project path + the exact commands to preview and
render. Always include the licensing warning for commercial use.

## Safety rules
- The tool only writes inside the workspace sandbox; rendering only runs via the gated
  `run_command`. Never claim a video was rendered unless the render command actually ran.
- **License:** Remotion is free for individuals, non-profits, and for-profit companies with
  ≤3 employees (combined headcount across collaborating teams counts). Larger for-profit
  orgs need a paid company license from remotion.pro. State this before producing commercial
  videos; never imply it is unconditionally free.
