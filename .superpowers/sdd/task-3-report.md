# Task 3: Frame Sampler — Report

**Status:** ✅ Complete

## Summary

Implemented an adaptive frame sampler (`FrameSampler`) for the Python video analysis engine. The sampler extracts JPEG frames at configurable baseline and burst rates, with burst sampling concentrated around scene cut boundaries. Deduplication prevents redundant frames when baseline and burst timestamps overlap.

## Files Created

| File | Description |
|------|-------------|
| `packages/python-engine/src/kove_engine/analyzers/frame_sampler.py` | `FrameSampler` class — adaptive frame extraction via ffmpeg |
| `packages/python-engine/tests/test_frame_sampler.py` | 4 unit tests covering baseline timestamps, burst timestamps, deduplication, and frame extraction |

## Test Results

```
tests/test_frame_sampler.py::test_frame_sampler_generates_baseline_timestamps PASSED
tests/test_frame_sampler.py::test_frame_sampler_generates_burst_timestamps PASSED
tests/test_frame_sampler.py::test_frame_sampler_deduplicates PASSED
tests/test_frame_sampler.py::test_frame_sampler_extracts_frames PASSED
4 passed in 0.02s
```

## Commit

```
de1d40d feat: add adaptive frame sampler with baseline + burst rates
```

## Design Notes

- **Baseline**: 1.5 fps across entire duration (configurable)
- **Burst**: 10 fps within ±2s of each scene cut (configurable)
- **Dedup**: Merges timestamps closer than 0.5s threshold (configurable)
- Uses `ffprobe` for duration, `ffmpeg` for per-frame JPEG extraction at `-q:v 2`
- Outputs to `tempfile.mkdtemp` with `kove_frames_` prefix
- Gracefully logs warnings on failed frame extractions rather than aborting
