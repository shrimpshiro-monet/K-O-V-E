# K.O.V.E. Video Analysis Engine

The analysis engine produces a versioned `referenceAnalysis` report for every input video. It is designed for edit reconstruction and AI-directed editing, not only scene captioning.

## Pipeline

1. `ffprobe` reads container, codec, frame-rate, resolution, audio-track, and frame-count metadata.
2. `ffmpeg` detects candidate scene boundaries and extracts adaptive samples.
3. OpenCV compares decoded neighboring frames for hard cuts, fades to black, motion spikes, black frames, color treatment, and overlay candidates.
4. WebRTC VAD, RMS analysis, and `librosa` inspect speech, silence, music, BPM, and energy.
5. MediaPipe and the existing visual/motion analyzers classify faces, talking heads, settings, and motion.
6. Optional Cloudflare vision analysis enriches sampled frames with shot type, visible text, semantic effects, color descriptions, and editorial purpose.

The local engine deliberately returns evidence and confidence rather than inventing exact NLE effects. OCR, semantic effect names, and ambiguous temporal transitions are marked as requiring vision or denser sampling.

## Requirements

- Python 3.11 or 3.12 (not 3.13+ — see below)
- `ffmpeg` and `ffprobe` on `PATH`
- A system OpenGL library, `libGL.so.1` (Debian/Ubuntu: `apt-get install -y libgl1`)
- The pinned dependencies in `pyproject.toml`

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

### Why the pins and the version bound

`mediapipe` pins `numpy<2`, which in turn caps `opencv-contrib-python` at
4.11.0.86 because later OpenCV releases require numpy 2. `mediapipe` also
requires the *non-headless* OpenCV build, which is where the `libGL.so.1`
requirement comes from. `opencv-python-headless` is not a drop-in substitute
while mediapipe remains a dependency: two distributions cannot both provide
`cv2`, and installing both is what produced the duplicated OpenCV install this
pin set replaces.

`mediapipe` removed the `mp.solutions` API that `face_analyzer.py` uses in 1.0,
and the last release that still provides it ships wheels only for CPython
3.9-3.12. That is why the floor is capped at `<3.13`: without the cap, Python
3.13 would resolve `mediapipe==1.1.0` and the face analyzer would fail at
import.

`webrtcvad-wheels` is the maintained fork of `webrtcvad`. The original ships
only an sdist and imports `pkg_resources`, which a clean venv lacks, so
`import webrtcvad` fails there. The fork ships prebuilt wheels for cp310-cp314;
the import name is unchanged.

`requirements.lock` records the full transitive closure these pins resolve to
on CPython 3.11. Move the pins deliberately and re-run the suite: several of
them constrain each other.

Run the local API with:

```bash
uvicorn server:app --reload --port 8000
```

`POST /analyze` accepts one or more local `video_paths` and returns both `segmentMap` and `referenceAnalysis`. `POST /analyze-frames` is the browser/frame-worker-compatible path.

## Analysis endpoints

The agent sends sampled frames to one of two backends, chosen by the composer's
analysis mode:

| Mode | Backend | Configured with |
| --- | --- | --- |
| `eco` | this Python engine (`POST /analyze-frames`) | `VITE_ECO_WORKER_URL`, or `KOVE_ECO_WORKER_URL` |
| `ai` | Cloudflare frame-worker | `VITE_VISION_WORKER_URL`, or `KOVE_VISION_WORKER_URL` |

In a development build (`import.meta.env.DEV`) `eco` falls back to
`http://localhost:8000/analyze-frames` so contributors can run the engine
locally with no configuration.

Production builds have no such fallback. A deployed app cannot reach a
visitor's `localhost`, so an unconfigured `eco` mode fails with an explicit
`ANALYSIS_UNAVAILABLE` message rather than a confusing network error, and an
endpoint that cannot be reached reports `ANALYSIS_UNREACHABLE`.

## AI mode

The agent uses local analysis in `eco` mode. Set `KOVE_VISION_WORKER_URL` and switch the agent analysis mode to `ai` to add Cloudflare vision enrichment. Temporal transition detection remains local because it requires comparing neighboring frames; the Worker is used for semantic visual interpretation.
