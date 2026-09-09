from __future__ import annotations

import logging
import re
import subprocess

logger = logging.getLogger(__name__)

TIMESTAMP_PATTERN = re.compile(r"pts_time:(\d+\.?\d*)")


class SceneDetector:
    def __init__(
        self,
        threshold: float = 0.3,
        min_scene_duration: float = 0.5,
    ) -> None:
        self.threshold = threshold
        self.min_scene_duration = min_scene_duration

    def detect(self, video_path: str) -> list[tuple[float, float]]:
        """Detect scene boundaries using ffmpeg's scene filter.

        Returns list of (start_time, duration) tuples for each scene segment.
        """
        try:
            return self._run_ffmpeg(video_path)
        except (FileNotFoundError, subprocess.CalledProcessError) as e:
            logger.warning("ffmpeg scene detection failed: %s — returning single scene", e)
            return [(0.0, 0.0)]

    def _run_ffmpeg(self, video_path: str) -> list[tuple[float, float]]:
        cmd = [
            "ffmpeg",
            "-i", video_path,
            "-vf", f"select='gt(scene,{self.threshold})',showinfo",
            "-f", "null",
            "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return self._parse_timestamps(result.stderr)

    def _parse_timestamps(self, stderr: str) -> list[tuple[float, float]]:
        raw_times = []
        for line in stderr.splitlines():
            match = TIMESTAMP_PATTERN.search(line)
            if match:
                raw_times.append(float(match.group(1)))

        if not raw_times:
            return [(0.0, 0.0)]

        raw_times.sort()

        # Filter out scenes shorter than min_scene_duration
        filtered = [raw_times[0]]
        for t in raw_times[1:]:
            if t - filtered[-1] >= self.min_scene_duration:
                filtered.append(t)

        # Build (start_time, duration) tuples
        scenes: list[tuple[float, float]] = []
        for i, start in enumerate(filtered):
            end = filtered[i + 1] if i + 1 < len(filtered) else start + 10.0
            scenes.append((start, end - start))

        return scenes