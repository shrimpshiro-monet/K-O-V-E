# End-to-end verification (real browser)

`vision.spec.ts` drives the **real editor in real headless Chromium**: it creates
a project through the UI, records a video fixture in the browser, imports it,
puts it on the timeline, opens the clip inspector's *Face & Subject Tools*
panel, and asserts on the resulting project state.

```bash
# from the repo root
pnpm --filter @kove-advanced/web test:e2e     # = node e2e/setup-assets.mjs && playwright test
```

`setup-assets.mjs` downloads the MediaPipe wasm runtime and the face model from
npm into `e2e/.assets/` (gitignored, ~25 MB) before the run. Playwright then
starts two servers: the asset server on `:8788` and Vite on `:5199`.

The suite is **skipped, not failed**, when no Chromium is available, so
`pnpm test` stays green on machines without a browser.

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
- The editor boots on a scratch canvas with `hasOpenProject: false` and the
  action executor rejects writes in that state (`"No project is open"`), so the
  fixture creates a project via the header switcher → *New Project* first.
- Headless Chromium throttles `requestAnimationFrame`; the fixture painter uses
  `setInterval` so recorded clips really are ~3 s long.
- On minimal sandboxes Chromium may need `LD_LIBRARY_PATH` pointing at the
  distro's libc/libstdc++ and a config where `--single-process`,
  `--in-process-gpu` and `--no-zygote` are filtered out; pass the binary via
  `KOVE_E2E_CHROMIUM`.
