"""Locate and run a real ffmpeg.

There is no system ffmpeg in the environment this was built for, and apt cannot
install one (the sandbox reaches pypi, npm and github only). `imageio-ffmpeg`
ships a static ffmpeg 7.x in its wheel, which is a real binary with the real
filters — `ebur128`, `loudnorm`, `sidechaincompress` all present — so every
measurement that says "ffmpeg" here is ffmpeg, not a reimplementation.

A system ffmpeg wins when one exists (`KOVE_FFMPEG`, then `PATH`), because that is
what a developer's machine and the packaging story will use.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache


class FfmpegUnavailableError(RuntimeError):
    """No ffmpeg could be located."""


@lru_cache(maxsize=1)
def ffmpeg_path() -> str:
    """Path to an ffmpeg binary, or raise."""
    explicit = os.environ.get("KOVE_FFMPEG")
    if explicit:
        if not os.path.exists(explicit):
            raise FfmpegUnavailableError(f"KOVE_FFMPEG points at a missing file: {explicit}")
        return explicit

    found = shutil.which("ffmpeg")
    if found:
        return found

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - depends on the environment
        raise FfmpegUnavailableError(
            "no ffmpeg found: set KOVE_FFMPEG, install one on PATH, or "
            f"pip install imageio-ffmpeg ({exc})"
        ) from exc


@dataclass(frozen=True)
class FfmpegResult:
    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def tail(self, lines: int = 12) -> str:
        return "\n".join(self.stderr.strip().splitlines()[-lines:])


def run(args: list[str], timeout: float = 900.0) -> FfmpegResult:
    """Run ffmpeg with `args` (after the binary), capturing both streams."""
    argv = [ffmpeg_path(), "-hide_banner", "-nostdin", *args]
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return FfmpegResult(
        args=tuple(argv),
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def run_checked(args: list[str], timeout: float = 900.0) -> FfmpegResult:
    """Run ffmpeg and raise with the tail of stderr when it fails."""
    result = run(args, timeout=timeout)
    if not result.ok:
        raise RuntimeError(
            f"ffmpeg exited {result.returncode}\n"
            f"  {' '.join(result.args)}\n{result.tail()}"
        )
    return result


def ffmpeg_version() -> str:
    """First line of `ffmpeg -version`, for the scorecard's provenance block."""
    result = run(["-version"])
    first = result.stdout.strip().splitlines() or result.stderr.strip().splitlines()
    return first[0] if first else "unknown"
