# Task 2 Report: Scene Detector

## Summary

Implemented an ffmpeg-based scene detector for the Python video analysis engine. The detector uses ffmpeg's scene filter to identify scene boundaries in video files and returns scene segments with start times and durations.

## Files Created

### 1. `packages/python-engine/src/kove_engine/analyzers/scene_detector.py`
- **Purpose**: Core scene detection logic using ffmpeg subprocess
- **Features**:
  - Configurable threshold (default 0.3) for scene change sensitivity
  - Configurable minimum scene duration (default 0.5s) to filter out brief flashes
  - Parses ffmpeg's showinfo filter output from stderr
  - Graceful error handling: returns `[(0.0, 0.0)]` on ffmpeg failures
  - Returns list of `(start_time, duration)` tuples for each scene segment

### 2. `packages/python-engine/tests/test_scene_detector.py`
- **Purpose**: Unit tests for scene detector functionality
- **Test Coverage**:
  - `test_scene_detector_returns_list_of_tuples`: Verifies output format
  - `test_scene_detector_min_scene_duration`: Tests filtering of short scenes
  - `test_scene_detector_handles_no_scene_changes`: Tests single-scene scenario
  - `test_scene_detector_ffmpeg_failure`: Tests graceful error handling

## Test Results

```
============================= test session starts ==============================
platform darwin -- Python 3.12.8, pytest-9.1.1
tests/test_scene_detector.py::test_scene_detector_returns_list_of_tuples PASSED
tests/test_scene_detector.py::test_scene_detector_min_scene_duration PASSED
tests/test_scene_detector.py::test_scene_detector_handles_no_scene_changes PASSED
tests/test_scene_detector.py::test_scene_detector_ffmpeg_failure PASSED
============================== 4 passed in 0.03s ===============================
```

## Implementation Notes

### Bug Fix Applied
The original test spec had a bug: mock output was provided on `stdout` but the code reads from `stderr` (ffmpeg's showinfo outputs to stderr by default). Fixed by changing mocks from `stdout=mock_output, stderr=""` to `stdout="", stderr=mock_output`.

### How It Works
1. Runs ffmpeg with: `ffmpeg -i <video> -vf select='gt(scene,0.3)',showinfo -f null -`
2. Parses stderr lines for `pts_time:<value>` patterns using regex
3. Filters timestamps by minimum scene duration
4. Converts timestamps to `(start, duration)` tuples

## Git Commit

```
commit 61c07f1
feat: add ffmpeg-based scene detector
```

## Concerns

1. **Last scene duration**: The last scene gets a default duration of 10.0 seconds when no following timestamp exists. This may need adjustment based on actual video duration.

2. **FFmpeg dependency**: Requires ffmpeg to be installed on the system. The detector gracefully handles `FileNotFoundError` by returning a single scene.

3. **Performance**: Full video processing for scene detection. For large videos, this could be slow. Consider adding timeout or progress callback in future iterations.