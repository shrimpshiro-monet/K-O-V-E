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

- Prefer the dedicated tool (328 of them) — it validates its arguments and returns
  a shaped result.
- For anything else, `list_action_types` enumerates the action types this build can
  dispatch (handler-backed types plus the executor's prefix domains), and
  `execute_action` / `batch_actions` dispatch them. An unknown type is refused
  loudly rather than silently ignored.
- The Auto Reframe camera move, for example, is `auto_reframe_clip` or the raw
  `keyframe/setAll` action with `position.x`/`position.y`/`scale.x`/`scale.y`.

## Known limits

- The renderer only composites separation while `BackgroundRemovalEngine` is
  initialized; both apply paths call `initialize()` and warn if it fails.
- Holes inside a subject are reported in warnings; mattes are written as their
  outer contour (a `BezierPath` has no sub-paths).
- Rotoscoping is batch analysis, not realtime: detection/segmentation run on
  sampled frames, then interpolate between keyframes.
