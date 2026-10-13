# K.O.V.E. Video Analysis Engine

The analysis engine produces a versioned `referenceAnalysis` report for every input video. It is designed for edit reconstruction and AI-directed editing, not only scene captioning.

## Pipeline

1. `ffprobe` reads container, codec, frame-rate, resolution, audio-track, and frame-count metadata.
2. OpenCV decodes the file at full frame rate and scores frame-to-frame content
   change against an adaptive threshold to find shot boundaries. `ffmpeg` is the
   fallback for containers OpenCV cannot open. There is no minimum scene length,
   so fast-cut references are measured rather than smoothed away.
3. OpenCV compares decoded neighboring frames for fades to black, motion spikes, black frames, color treatment, and overlay candidates.
4. WebRTC VAD, RMS analysis, and `librosa` inspect speech, silence, music, BPM, and energy.
5. MediaPipe and the existing visual/motion analyzers classify faces, talking heads, settings, and motion.
6. Optional Cloudflare vision analysis enriches sampled frames with shot type, visible text, semantic effects, color descriptions, and editorial purpose.

The local engine deliberately returns evidence and confidence rather than inventing exact NLE effects. OCR, semantic effect names, and ambiguous temporal transitions are marked as requiring vision or denser sampling.

## Requirements

- Python 3.11 or 3.12 (not 3.13+ — see below)
- `ffmpeg` and `ffprobe` on `PATH`
- The pinned dependencies in `pyproject.toml`

No system OpenGL library is needed. The engine uses `opencv-python-headless`,
which is what makes it installable on a headless host — the previously pinned
`opencv-contrib-python` build aborted at `import cv2` with
`libGL.so.1: cannot open shared object file` wherever `libgl1` was absent.

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

### Face detection is optional

`mediapipe` is **not** part of the core install. `FaceAnalyzer` degrades to zero
faces and logs one warning when the backend is absent, so the pipeline runs
either way (`face_analyzer.py`).

Enabling it is a deliberate *replacement* of OpenCV rather than an extra, because
`mediapipe==0.10.21` hard-requires `opencv-contrib-python` (non-headless) and
`numpy<2`. Installing it alongside the headless build leaves two distributions
writing into `cv2/`, and `import cv2` then fails outright.

Use a **fresh** virtualenv — do not convert an existing one in place:

```bash
python -m venv .venv
apt-get install -y libgl1                      # required by the contrib build
.venv/bin/pip install -r requirements-faces.txt
.venv/bin/pip install -e ".[dev]"              # resolves numpy<2 against the same set
```

`requirements-faces.txt` pins `numpy==1.26.4` and
`opencv-contrib-python==4.11.0.86` so exactly one package provides `cv2`. Swap
the order of the last two lines and pip's resolver picks `numpy` 2.x, which
mediapipe cannot use.

Switching in place is unreliable even when done "correctly": `pip uninstall`
does not remove files that the other OpenCV distribution also shipped, so a
converted environment can keep loading a mixture of the two builds. That is why
the recipe starts from a new venv. The lasting fix is migrating
`face_analyzer.py` to the mediapipe Tasks API, which carries neither constraint.

### Why the pins and the version bound

Core pins the versions verified by running the test suite on CPython 3.11.
`numpy` and `opencv-python-headless` are the two ranges rather than exact pins,
because the optional face-detection set has to be able to resolve against this
same declaration; `requirements.lock` records the exact verified closure of the
default install.

The version bound follows the optional face-detection set rather than the core:
`mediapipe` removed the `mp.solutions` API that `face_analyzer.py` uses in 1.0,
and the last release that still provides it ships wheels only for CPython
3.9-3.12. Core has no upper bound of its own, but one matrix that everything has
actually been verified against is worth more than an untested 3.13 core.

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
