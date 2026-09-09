from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


class FrameSampler:
    def __init__(
        self,
        baseline_fps: float = 1.5,
        burst_fps: float = 10.0,
        burst_window: float = 2.0,
        dedup_threshold: float = 0.5,
    ) -> None:
        self.baseline_fps = baseline_fps
        self.burst_fps = burst_fps
        self.burst_window = burst_window
        self.dedup_threshold = dedup_threshold

    def sample(
        self, video_path: str, scene_cuts: list[tuple[float, float]]
    ) -> list[tuple[float, str]]:
        """Extract frames at adaptive timestamps.

        Returns list of (timestamp, image_path) tuples.
        """
        duration = self._get_duration(video_path)
        timestamps = self._compute_timestamps(duration, scene_cuts)
        return self._extract_frames(video_path, timestamps)

    def _get_duration(self, video_path: str) -> float:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())

    def _compute_timestamps(
        self, duration: float, scene_cuts: list[tuple[float, float]]
    ) -> list[float]:
        timestamps: set[float] = set()

        # Baseline sampling
        t = 0.0
        while t < duration:
            timestamps.add(round(t, 3))
            t += 1.0 / self.baseline_fps

        # Burst sampling around scene cuts
        for cut_start, _cut_duration in scene_cuts:
            burst_start = max(0.0, cut_start - self.burst_window)
            burst_end = min(duration, cut_start + self.burst_window)
            t = burst_start
            while t < burst_end:
                timestamps.add(round(t, 3))
                t += 1.0 / self.burst_fps

        sorted_times = sorted(timestamps)

        # Deduplicate: merge timestamps within threshold
        if not sorted_times:
            return []

        deduped = [sorted_times[0]]
        for t in sorted_times[1:]:
            if t - deduped[-1] >= self.dedup_threshold:
                deduped.append(t)

        return deduped

    def _extract_frames(
        self, video_path: str, timestamps: list[float]
    ) -> list[tuple[float, str]]:
        output_dir = Path(tempfile.mkdtemp(prefix="kove_frames_"))
        result: list[tuple[float, str]] = []

        for ts in timestamps:
            output_path = output_dir / f"frame_{ts:.3f}.jpg"
            cmd = [
                "ffmpeg", "-ss", str(ts),
                "-i", video_path,
                "-frames:v", "1",
                "-q:v", "2",
                "-y", str(output_path),
            ]
            try:
                subprocess.run(cmd, capture_output=True, check=True)
                result.append((ts, str(output_path)))
            except subprocess.CalledProcessError as e:
                logger.warning("Failed to extract frame at %.3fs: %s", ts, e)

        return result
