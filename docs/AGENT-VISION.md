# Agent Vision — Face Detection, Subject Segmentation & Rotoscoping

Browser-local (no API keys) pipeline for finding faces, isolating subjects, and
turning segmentation mattes into tracked, editable masks.

See also: `AGENT-CAPABILITIES.md` (generated tool reference),
`ARCHITECTURE.md` (package map).

## Layers

| Layer | File | Responsibility |
|---|---|---|
| Face detection engine | `packages/core/src/ai/face-detection-engine.ts` | Pluggable `FaceDetectionBackend`; MediaPipe backend; IoU tracker with EMA smoothing, occlusion gaps, primary-face scoring |
| Rotoscope geometry | `packages/core/src/ai/rotoscope.ts` | Matte → contours (Moore tracing) → RDP simplify → normalized Bezier paths → temporal keyframe plan |
| Subject separation | `packages/core/src/ai/subject-separation.ts` | Presets (`cutout`, `transparent`, `blur-background`, `color-background`, `image-background`), planning/validation, canvas-free RGBA compositing, quality report |
| Browser orchestration | `apps/web/src/services/agent/vision-analysis.ts` | Frame decoding, engine calls, `mask/setAll` mask writing, clip speed/reverse mapping |
| Agent tools | `packages/agent/src/tools-vision.ts` | `detect_faces`, `rotoscope_subject`, `apply_subject_matte` |
| Inspector UI | `apps/web/src/components/editor/inspector/SubjectToolsPanel.tsx` | Review-first panel in the AI tab |

## Data flow

```
media blob
  → decode sampled frames (detached <video> + canvas, ≤960px long edge)
  → faces:   FaceDetectionBackend.detect  → trackFaces → face tracks + primary
  → mattes:  PersonSegmentationEngine     → alphaFromRgba → planRotoscope
  → masks:   writeMatteToMasks → mask/setAll action (single undo step)
             + MaskEngine.loadMasks (live preview)
  → separation: planSubjectSeparation → BackgroundRemovalEngine settings
```

Sampling windows are source seconds; a clip defaults to `inPoint..outPoint`.
Matte keyframe times are written on the **timeline** clock
(`sourceTimeToTimelineSeconds`), so clip speed and reverse stay correct.

## No-key / test strategy

- MediaPipe models and WASM are fetched from public CDNs — no API key, no account.
- Unit tests never touch the network: `FaceDetectionEngine` takes a backend
  factory, `vision-analysis` takes injected decoder/engine dependencies, and
  the agent host exposes optional `analyzeFaces` / `analyzeSubjectMatte` /
  `applySubjectMatte` methods that tests implement with fixtures.
- `HeadlessHost` reports all three vision features as `false`, so the tools fail
  with `UNSUPPORTED_HOST` instead of silently no-oping.
- `auto_reframe_clip` works the same way: the host seam exposes `autoReframe`, and
  the browser suite drives the inspector's Auto Reframe section end to end.

## Choosing a tool (for the agent)

Every editor capability is reachable, even where no dedicated tool exists:

- Prefer the dedicated tool (330 of them) — it validates its arguments and returns
  a shaped result.
- For anything else, `list_action_types` enumerates the action types this build can
  dispatch (handler-backed types plus the executor's prefix domains), and
  `execute_action` / `batch_actions` dispatch them. An unknown type is refused
  loudly rather than silently ignored.
- The Auto Reframe camera move, for example, is `auto_reframe_clip` or the raw
  `keyframe/setAll` action with `position.x`/`position.y`/`scale.x`/`scale.y`.

## Matte edge refinement

A rotoscoped matte's edge is per-keyframe state, not a single mask-wide value.
`MaskKeyframe` carries optional `feathering` / `expansion` / `inverted` /
`opacity` overrides; `resolveMaskEdgeAtTime()` blends them between keyframes
(booleans hold, numbers interpolate), and a keyframe that omits one inherits the
mask's own value — so mattes written before this existed resolve to exactly the
old uniform edge.

`planMatteEdgeRefinement()` derives the values: `featherPx` is the edge softness
where the subject is still, and `motionSensitivity` (0..1) widens it where the
subject moves — where sampled contours lag and motion blur already smears the
silhouette — up to `maxFeatherPx`. Motion is a normalized mix of centroid travel
and coverage change, scaled against the busiest keyframe, so it is
resolution- and framerate-independent.

Reachable three ways:

- inspector: *Face & Subject Tools* → Edge refinement, with a live before/after
  canvas preview and a per-keyframe feather list
- `apply_subject_matte` with an `edge` block (writes the matte and refines it)
- `refine_matte_edges` on a mask that already exists — it reads the committed
  keyframe paths and recovers each silhouette's centroid and area from them, so
  refining an edge never re-runs segmentation

## Hand-editing a keyframe's edge

The planner is not the only writer any more. Every mask with keyframes has a
*Keyframe edges* block in *Masking*: pick a keyframe, set its feather,
expansion and opacity, and scrub a slider that shows the edge the renderer will
actually blend at that instant — the preview reads `resolveMaskEdgeAtTime`, the
same function the compositor uses, so a hand-set value interpolates against its
neighbours exactly like a planned one.

A keyframe without an override inherits the mask's own feather/expansion/
opacity, which is what keeps mattes written before this existed looking
unchanged. The reset button drops a keyframe's overrides rather than setting
them to the current values, so "inherit" stays distinguishable from "happen to
match".

The agent drives the same state directly: `execute_action` with `mask/setAll`,
where each keyframe may carry `feathering`, `expansion`, `inverted` and
`opacity` overrides. Setting one is a hand edit; omitting it is the reset.

## Follow-cam: how the camera path is smoothed

`analyzeClip` decides where the camera looks once per *sampled* frame, but what
reaches the screen is the polyline the renderer draws between the emitted
keyframes. Two things used to make that look worse than the analysis was:

- a centred moving average whose window was sized from `smoothing` alone, so on
  a short clip it could span nearly the whole path and average the camera move
  out of existence
- linear interpolation between coarse samples, at a few hundred milliseconds
  apart, which changes the camera's speed in visible steps at every keyframe

`reframe-camera-path.ts` replaces both. Samples are de-jittered with a bounded
moving average (never wider than a third of the samples), a monotone spline is
fitted through them, and keyframes are placed only where the curve bends —
densely enough that the drawn polyline stays within a pixel tolerance of it.
Monotone tangents mean the fit never overshoots past where the analysis said
the subject was.

Measured on a subject that walks across frame and stops, the worst single step
in camera speed drops from **1.00 to 0.25** of the path's top speed, while the
camera still travels the same 588px — smoothing no longer costs the move.

The inspector and `auto_reframe_clip` both report `pathDeviationPx` (how closely
the emitted keyframes follow the fitted curve) and `peakSpeedCropRatios` (how
fast the camera crosses its own crop width), so the quality of a camera move is
visible instead of implied.

## Motion-adaptive reframe sampling

`analyzeClip` makes one crop decision per *sampled* frame, so the sampling grid
is the resolution of the whole camera move. A single grid has to be picked
blind: dense enough for the fastest moment in the clip, which wastes decodes on
every locked-off shot, or coarse, which under-samples that fast moment and lets
the camera cut the corner instead of following it.

Auto-reframe now measures first and samples second:

1. a coarse pass decodes the base grid (half of the frame budget) and scores
   the mean luma change between consecutive thumbnails
2. `planAdaptiveSampleTimes` bisects the busiest intervals with the remaining
   budget — motion is treated as spread evenly across an interval, so splitting
   halves each child's score and leaves its density unchanged, and the greedy
   pass keeps subdividing the same busy region until it hits the 90 ms floor
3. a second pass decodes only the newly added times, and every crop is stamped
   with its own timestamp instead of `index / frameRate`, because the grid is no
   longer uniform

Density rather than raw score is what ranks the intervals: a slow drift across a
whole clip moves further in total than a fast cut, and ranking by total would
spend the budget on the drift.

`intervalMs` and `maxFrames` describe the base grid and the budget either way;
only `adaptive: false` pins the single-pass grid. The inspector and
`auto_reframe_clip` report `refinedFrames` — how many samples the second pass
added — so the choice the sampler made is visible.

## Known limits

- Motion-adaptive sampling refines from the *coarse* pass's motion: a subject
  that moves only between two base samples is still missed on the first pass and
  cannot be recovered by splitting them.
- The motion score is a mean luma difference at thumbnail size, so a fast cut
  between two identically-lit shots scores low. Ranking is relative, and a clip
  with no measurable motion anywhere simply keeps its base grid.
- The renderer only composites separation while `BackgroundRemovalEngine` is
  initialized; both apply paths call `initialize()` and warn if it fails.
- The edge preview approximates the renderer's morphological grow/shrink with a
  canvas stroke; the blur (feather) step is the same operation the renderer uses.
- Motion is measured between keyframes, so a reframe/matte sampled very coarsely
  sees coarser motion too.
- Holes inside a subject are reported in warnings; mattes are written as their
  outer contour (a `BezierPath` has no sub-paths).
- Rotoscoping is batch analysis, not realtime: detection/segmentation run on
  sampled frames, then interpolate between keyframes.
- Auto-reframe can only pan on the axes its crop leaves free. A 9:16 crop of
  16:9 footage fills the frame vertically, so there is no vertical camera
  movement to be had — the engine says so in its warnings rather than
  pretending to smooth an axis it cannot move.
