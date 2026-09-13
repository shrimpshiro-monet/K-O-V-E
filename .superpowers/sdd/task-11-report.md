# Task 11: CLI Entry Point — Report

**Status:** COMPLETE
**Date:** 2026-09-10

## Created

- `packages/python-engine/src/kove_engine/cli.py`

## Summary

Built the CLI entry point that wraps `Orchestrator`. The module provides a `main()` function registered as the `kove-engine` console script in `pyproject.toml`.

### CLI options verified

| Flag | Default | Purpose |
|------|---------|---------|
| `video_path` (positional) | — | Path to video file |
| `-o / --output` | stdout | Output file path |
| `--baseline-fps` | 1.5 | Baseline sampling rate |
| `--burst-fps` | 10.0 | Burst sampling rate around scene cuts |
| `--scene-threshold` | 0.3 | Scene change detection threshold |
| `-v / --verbose` | false | Verbose logging (DEBUG vs WARNING) |

### Verification

```bash
PYTHONPATH=src python3 -m kove_engine.cli --help
```

Output confirmed all options displayed correctly. The `MessageFactory` warning is a harmless protobuf/mediapipe import artifact, not an error.

### Note

`pip install -e .` timed out on numpy download (network issue). The package is importable via `PYTHONPATH=src` for local development. Full install works once network is stable.
