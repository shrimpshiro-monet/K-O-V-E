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

## Known limits

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
