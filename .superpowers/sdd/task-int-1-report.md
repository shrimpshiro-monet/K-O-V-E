# Task 1: Add progress callback to the Orchestrator

**Status:** ✅ COMPLETE

## Changes Made

File modified: `packages/python-engine/src/kove_engine/orchestrator.py`

1. Added `Callable` import from `collections.abc`
2. Added `VideoSegmentMap` import from `kove_engine.types`
3. Added `on_progress: Callable[[dict], None] | None = None` parameter to `__init__`
4. Added `_emit()` helper method that calls the callback with `{"stage": ..., "message": ..., **kwargs}`
5. Added progress emits in `analyze()`:
   - `scene_detecting` → when starting scene detection
   - `extracting_frames` → when starting and completing frame extraction (with `total`)
   - `building_segments` → when starting segment building
   - `done` → when analysis completes
6. Added progress emits in `_analyze_frames()`:
   - `analyzing_frame` → per-frame with `current` and `total` counts

## Backward Compatibility

- `on_progress` is optional with default `None`
- No existing API signatures changed
- All existing tests pass without modification

## Test Results

```
47 passed, 1 skipped in 6.20s
```

## Report Path

`/Users/hamza/Desktop/k.o.v.e/.superpowers/sdd/task-int-1-report.md`
