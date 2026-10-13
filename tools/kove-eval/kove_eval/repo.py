"""Where things are, and how to reach the repo's Python packages.

`kove-eval` deliberately lives outside `packages/` so it cannot be mistaken for
shipped code, but it imports the engine's analyzers — those are the same code the
product runs, and a scorecard built on a second implementation of scene detection
would be measuring the second implementation.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve()
TOOLS = HERE.parent.parent  # tools/kove-eval
REPO_ROOT = TOOLS.parent.parent  # repository root

PYTHON_ENGINE = REPO_ROOT / "packages" / "python-engine"
PYTHON_ENGINE_SRC = PYTHON_ENGINE / "src"
CREATION_SCHEMA = REPO_ROOT / "packages" / "creation-schema"

DEFAULT_EVAL_ROOT = REPO_ROOT / "evaluation-files" / "craft"
DEFAULT_RUNS_ROOT = DEFAULT_EVAL_ROOT / "runs"


def ensure_engine_importable() -> None:
    """Put the engine's `src` on `sys.path` so `kove_engine.*` imports resolve.

    Only the path is added; the package is imported normally. If the engine has
    been `pip install -e`'d the import would work anyway — this keeps the harness
    runnable from a bare checkout too.
    """
    path = str(PYTHON_ENGINE_SRC)
    if path not in sys.path:
        sys.path.insert(0, path)


HARNESS_BIN = REPO_ROOT / ".cache" / "kove-eval-bin"


def ensure_tools_on_path() -> list[str]:
    """Put the harness's ffmpeg on PATH for in-process engine calls.

    `kove_engine.beat_grid.extract_audio_track` shells out to a bare `ffmpeg`
    binary. When that is missing it logs one warning and returns None, and the
    engine reports "no beat grid" — so every rhythm metric becomes None and a
    missing tool looks exactly like a track with no pulse. That trap is closed here
    loudly, on the harness side; whether the shipped engine should accept
    `KOVE_FFMPEG` itself is a separate decision (recorded in docs/CRAFT_LOG.md).

    Returns the tool names linked, for the scorecard's provenance block.
    """
    import os

    from .ffmpeg import ffmpeg_path

    HARNESS_BIN.mkdir(parents=True, exist_ok=True)
    links: list[str] = []

    ffmpeg = Path(ffmpeg_path())
    target = HARNESS_BIN / "ffmpeg"
    if target.is_symlink():
        target.unlink()
    elif target.exists() and target.resolve() != ffmpeg.resolve():
        target.unlink()
    if not target.exists():
        target.symlink_to(ffmpeg)
    links.append("ffmpeg")

    # Sibling ffprobe, when the binary came as a pair. Other repo code paths call
    # a bare `ffprobe`.
    sibling = ffmpeg.with_name(ffmpeg.name.replace("ffmpeg", "ffprobe"))
    if sibling.exists():
        probe_target = HARNESS_BIN / "ffprobe"
        if probe_target.is_symlink():
            probe_target.unlink()
        if not probe_target.exists():
            probe_target.symlink_to(sibling)
        links.append("ffprobe")

    path = os.environ.get("PATH", "")
    if str(HARNESS_BIN) not in path.split(os.pathsep):
        os.environ["PATH"] = str(HARNESS_BIN) + os.pathsep + path
    os.environ.setdefault("KOVE_FFMPEG", str(ffmpeg))
    return links
