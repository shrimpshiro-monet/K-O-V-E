# Testing agent tools against the editor UI

This is the contract for proving that a tool the AI director can call actually
reaches **every pillar of the editor** — the project model, the timeline, the
preview canvas, keyframes and the inspector — instead of only returning
`{ ok: true }`.

The reference implementation is the last test in `apps/web/e2e/vision.spec.ts`
("agent tools land on the timeline, in the preview and on the keyframe clock").
Read that test alongside this document.

## The seams

Every visible capability is reached through the same chain, and each hop is
observable from a Playwright test:

```
director / model
  └─ tool name + args          (packages/agent/src/registry.ts)
      └─ executeTool(name, args, host)      ← the seam the browser test calls
          └─ LiveEditorHost      (apps/web/src/services/agent/live-host.ts)
              └─ project store actions      (packages/core/src/actions)
                  ├─ project model           → project.timeline.tracks / project.textClips
                  ├─ timeline UI             → [data-timeline-view] row text + attributes
                  ├─ preview canvas          → canvas[data-preview-canvas] pixels
                  └─ keyframes / inspector   → clip.keyframes, section readouts
```

A test that stops at `result.ok` proves nothing about the pillars: it proves the
tool's own handler ran. Drive the tool, then read the pillars back independently.

## Calling a tool from the browser

```ts
const result = await page.evaluate(
  async ({ toolName, toolArgs }) => {
    const [{ executeTool }, { getLiveEditorHost }] = await Promise.all([
      import("/@id/@kove-advanced/agent"),          // Vite-resolved workspace source
      import("/src/services/agent/host-singleton.ts"),
    ]);
    return executeTool(toolName, toolArgs, getLiveEditorHost());
  },
  { toolName: "create_text_clip", toolArgs: { clip: { text: "PILLAR", startTime: 3.5, duration: 1.4 } } },
);
```

* This is the same registry → host → store path the loop uses; only the model is
  absent. It therefore also covers tools the director only reaches through
  `search_tools` / `run_tool` — see `packages/agent/src/tool-reachability.test.ts`
  for the routing guarantees.
* Import the source through Vite (`/@id/@kove-advanced/agent`,
  `/src/stores/...`), never a built bundle, or a test can pass against stale code.
* No model, key or network is involved: the tools under test are deterministic.

## Reading the pillars back

| Pillar | How to read it | What to assert |
| --- | --- | --- |
| Project model | `useProjectStore.getState().project` | the clip exists with the exact payload the tool received (`project.textClips`, `clip.keyframes`, track ids) |
| Timeline UI | `[data-timeline-view]` and the clip rows | `data-track-count` equals `tracks.length`, `data-playhead-sec` equals the playhead, the row's accessible name contains the clip (`Select text clip PILLAR`) |
| Preview | `canvas[data-preview-canvas]` | pixel content changes after the write, at the same playhead |
| Keyframes | `clip.keyframes` + preview motion over time | the values are what the tool sent, and the rendered picture moves/animates accordingly |

The stable handles are intentional API for tests:

* `data-preview-canvas` — the preview `<canvas>` (`Preview.tsx`).
* `data-timeline-view` on the timeline shell, plus `data-track-count` and
  `data-playhead-sec` (`Timeline.tsx`).

Prefer these over CSS classes, screenshot baselines or element order.

## Sampling the preview honestly

`samplePreview()` in `vision.spec.ts` shows the three habits that keep pixel
assertions from lying:

1. **Move the playhead explicitly** (`setPlayheadPosition`) and wait two animation
   frames, nudging off the target time first so a repeated read cannot hand back a
   stale composite.
2. **Measure a property that cannot saturate.** A frame-filling clip shifted to
   the right saturates a luminance centroid at 50%, so the test measures the
   picture's *left edge* instead: the first column where ≥20% of sampled rows are
   lit. It moves by exactly the shift.
3. **Ignore the near-black backdrop** (luma > 40) so letterboxing, the empty
   canvas background and antialiasing do not read as content.

Always compare against a **same-time baseline**: sample, change one thing through
a tool, sample the same playhead again. Comparing different times folds the
media's own motion into the result.

## Units (the mistake this pattern exists to prevent)

* Clip transform keyframes (`position.x`, `position.y`, `scale.x`, `scale.y`) are
  in **project pixels**, because that is what `drawFrameWithTransform` translates
  by and what `reframePlanToTransformKeyframes` emits. A keyframe of `0.45` moves
  the clip by 0.45 px, not 45% of the frame. Read
  `project.settings.width` inside the test instead of hard-coding a guess.
* Auto-reframe crops coming out of `AutoReframeEngine` are in **analyzed-frame
  pixels** — divide by `frames[0].bitmap.width/height` before treating them as
  normalized.
* Text clips are positioned by their own animation engine, so text assertions
  measure content presence/absence rather than edge geometry.

## Running it

```bash
pnpm --filter @kove-advanced/web test:e2e          # assets + Playwright
pnpm --filter @kove-advanced/web exec playwright test e2e/vision.spec.ts -g "pillars"
```

Sandbox/CI notes:

* `e2e/README.md` covers the browser provisioning recipe
  (`KOVE_E2E_CHROMIUM`), the asset server and what is real vs stubbed.
* MediaPipe Tasks (the face model) needs a **WebGL context**, even on its CPU
  delegate — the tasks build converts images through WebGL. Headless Chromium
  builds without SwiftShader libs therefore cannot run it: those tests skip with
  an explicit reason instead of failing, and `createMediaPipeFaceBackend` retries
  a failing GPU delegate once on the CPU delegate before reporting.
* Everything else in the suite — the stub segmenter, the timeline, the preview,
  the agent-tool path — needs no GPU.
