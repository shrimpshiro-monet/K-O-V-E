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

- Python 3.11+
- `ffmpeg` and `ffprobe` on `PATH`
- Python dependencies from `pyproject.toml`

Run the local API with:

```bash
uvicorn server:app --reload --port 8000
```

`POST /analyze` accepts one or more local `video_paths` and returns both `segmentMap` and `referenceAnalysis`. `POST /analyze-frames` is the browser/frame-worker-compatible path.

## AI mode

The agent uses local analysis in `eco` mode. Set `KOVE_VISION_WORKER_URL` and switch the agent analysis mode to `ai` to add Cloudflare vision enrichment. Temporal transition detection remains local because it requires comparing neighboring frames; the Worker is used for semantic visual interpretation.
