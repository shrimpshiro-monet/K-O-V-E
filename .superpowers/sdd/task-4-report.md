# Task 4: Motion Analyzer — Report

## Status: DONE

## What was built

`packages/python-engine/src/kove_engine/analyzers/motion_analyzer.py` — a `MotionAnalyzer` class that computes motion level between consecutive frames using OpenCV frame differencing.

## Implementation details

- **Frame differencing**: Loads current and previous frames as grayscale 64×64 images, computes absolute difference via `cv2.absdiff`, and normalizes the mean pixel difference to a 0–1 score.
- **Threshold classification**: Scores are bucketed into `STATIC` (< 0.02), `LOW` (< 0.08), `MEDIUM` (< 0.20), and `HIGH` (≥ 0.20).
- **Edge case**: When `prev_frame_path` is `None`, returns `STATIC` with a raw score of 0.0.
- **Image loading**: Resizes to 64×64 for consistent comparison regardless of source resolution. Raises `ValueError` on load failure.

## Tests

| Test | Result |
|------|--------|
| `test_static_frame_returns_static` | PASS |
| `test_high_motion_returns_high` | PASS |
| `test_no_previous_frame_returns_static` | PASS |
| `test_motion_level_thresholds` | PASS |

4/4 passed.

## Commit

`feat: add motion analyzer with frame differencing`

## Files created

- `packages/python-engine/src/kove_engine/analyzers/motion_analyzer.py`
- `packages/python-engine/tests/test_motion_analyzer.py`
