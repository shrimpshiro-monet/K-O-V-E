# End-to-end verification (real browser)

`vision.spec.ts` drives the **real editor in real headless Chromium**: it creates
a project through the UI, records a video fixture in the browser, imports it,
puts it on the timeline, opens the clip inspector's *Face & Subject Tools*
panel, and asserts on the resulting project state.

The last test drives **agent tools** through the same path the AI director uses
(`executeTool(name, args, host)` — registry → host → store, minus the model) and
then reads every pillar back: project model, timeline rows and attributes,
preview canvas pixels, and clip keyframes animating that canvas. The pattern,
its stable data attributes and the unit traps are documented in
`docs/AGENT-UX-TESTING.md`.

```bash
# from the repo root
pnpm --filter @kove-advanced/web test:e2e     # = node e2e/setup-assets.mjs && playwright test
```

`setup-assets.mjs` downloads the MediaPipe wasm runtime and the face model from
npm into `e2e/.assets/` (gitignored, ~25 MB) before the run. Playwright then
starts two servers: the asset server on `:8788` and Vite on `:5199`.

The suite is **skipped, not failed**, when no Chromium is available, so
`pnpm test` stays green on machines without a browser.

### Browser requirements

MediaPipe Tasks — the face model — needs a **WebGL context**, including on its
CPU delegate (the tasks build converts frames through WebGL). Playwright's own
Chromium ships SwiftShader and works anywhere; some minimal builds
(`@sparticuz/chromium`, used in sandboxes) do not, and then every face detection
frame fails with `Cannot read properties of undefined (reading 'activeTexture')`
after the backend has already retried on the CPU delegate. The face test detects
that (`hasWebgl`) and **skips with a reason** instead of failing, because it is a
property of the browser, not of the edit. Everything else in the suite needs no
GPU.

## What is real vs substituted

Everything the app does is real; only the segmentation *weights* are synthetic.

| Part | Status |
| --- | --- |
| Chromium, the editor, project creation, media import, timeline | real |
| Video fixture | recorded in-browser via `MediaRecorder` (deterministic 30 fps `setInterval` painter) |
| MediaPipe wasm runtime | real, served from `@mediapipe/tasks-vision` |
| Face model | real `face_landmarker.task` (from the `mediapipe-nodejs` npm package) |
| Segmentation worker + protocol, temporal smoothing, rotoscope geometry, mask write, undo group | real |
| Segmentation **model weights** | synthetic — `stub-segmenter-runtime.cjs` |
| Auto reframe (crop plan → clip transform keyframes) | real, with the real face model steering the crop |

## What the assertions prove

The suite is deliberately not satisfied by "some keyframes appeared". Both tests
were mutation-checked: breaking the pipeline makes them fail.

Face test:

- a real track count (`0 face track(s)` fails), not just the words "face track"
- the track's own detail line (`640×480 · 2.9s · conf 0.71`) must report a span
  longer than half a second and a confidence above 0.2 — that is tracking across
  many sampled frames, which a single lucky frame cannot produce (verified by
  mutating the analysis to one frame: the test goes red)
- the model and runtime came from the local asset server, never a CDN

Auto-reframe test:

- clicking "Analyze & Reframe" resizes the canvas to the target resolution
- the clip ends up with all four animated camera properties
  (`position.x/y`, `scale.x/y`), and `scale.x` is above 1 — an identity
  transform would mean the reframe did nothing

Agent-tool pillars test (no model, no keys):

- `create_text_clip` through the real tool path puts the text in
  `project.textClips`, in a timeline row (`Select text clip PILLAR`) and into the
  preview's pixels at a time where the video shows nothing — the empty frame is
  the same-time baseline
- the timeline shell reports the same numbers as the model
  (`data-track-count`, `data-playhead-sec`)
- `set_clip_keyframes` writes clip keyframes in *project pixels* (the units the
  renderer and auto-reframe use), the model holds exactly what was sent, the
  preview's picture moves at the same playhead by the shifted amount, and it
  interpolates — early in the clip the picture is still closer to its
  untransformed position

Matte test:

- one mask on the clip, carrying as many keyframes as the panel reported
- every keyframe is a closed path with more than two anchors, and its centroid
  sits in normalized frame space (pixel coordinates would fail)
- keyframe times are ascending, distinct and span more than a second — proof the
  analysis walked the video (mutating the time mapping collapses the keyframes
  and the test goes red)
- the traced centroid actually moves between keyframes, so the matte follows the
  subject rather than being one frozen shape
- coverage of the subject stays in a sane band

### Why the segmenter is stubbed

The official `selfie_segmenter` / `selfie_multiclass` Tasks models are only
published at `storage.googleapis.com` URLs and on Hugging Face; both are
unreachable from this environment, and every GitHub copy is a git-lfs pointer
(see `docs/AGENT-VISION.md`). Rather than skip the feature, the asset server
serves a bundle that satisfies the worker's `importScripts(tasksVisionBundleUrl)`
contract with `FilesetResolver` / `ImageSegmenter` doubles returning a drifting
elliptical alpha matte.

Consequences worth knowing:

- The subject matte has a **known shape**, so the tests can assert on coverage
  (≈32 %) and keyframe counts.
- A regression in the worker protocol, the engine, the rotoscope or the mask
  write still fails the suite — those parts run unmodified.
- Face detection is unaffected: it loads the real runtime and model.

Set `KOVE_E2E_STUB_SEGMENTER=0` to serve the real bundle instead (the run will
then need real segmenter weights at `{base}/models/selfie_multiclass_256x256.tflite`).

## Environment knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `KOVE_E2E_CHROMIUM` | unset | Path to a Chromium binary to use instead of Playwright's bundled one |
| `KOVE_E2E_APP_PORT` | `5199` | Port for the Vite dev server |
| `KOVE_E2E_ASSET_PORT` | `8788` | Port for the local media/model asset server |
| `KOVE_E2E_FACE_MODEL` | `face-landmarker` | Face model id the app is asked for (`face-landmarker` uses the offline `.task` model) |
| `KOVE_E2E_STUB_SEGMENTER` | `1` | Serve the synthetic segmentation model |

## Layout

```
e2e/
  vision.spec.ts              the suite
  setup-assets.mjs            copies wasm + runtime + face model into .assets/
  asset-server.mjs            serves .assets/ and fixtures/ on :8788
  stub-segmenter-runtime.cjs  synthetic MediaPipe runtime for the segmenter
  fixtures/                   committed fixtures (source portrait)
  .assets/                    generated, gitignored
```

Failure artifacts (screenshots, traces, DOM snapshots) land in
`apps/web/test-results/<test-slug>/`.

## Sandbox / CI notes

- Hovering a media tile reveals a full-tile overlay; the suite uses the
  overlay's `Add to timeline` button (same handler as double-clicking the
  thumbnail) to avoid pointer-event races.
- The editor opens a scratch project by itself on boot (`useEnsureOpenProject`);
  the fixture asserts that before doing anything else, because the store's
  action executor rejects writes while no project is open (which is how the
  subject matte gets written).
- Headless Chromium throttles `requestAnimationFrame`; the fixture painter uses
  `setInterval` so recorded clips really are ~3 s long.
- On minimal sandboxes Chromium may need `LD_LIBRARY_PATH` pointing at the
  distro's libc/libstdc++ and a config where `--single-process`,
  `--in-process-gpu` and `--no-zygote` are filtered out; pass the binary via
  `KOVE_E2E_CHROMIUM`.
