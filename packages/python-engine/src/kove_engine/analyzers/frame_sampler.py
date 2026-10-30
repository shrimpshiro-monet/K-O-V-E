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
        dedup_threshold: float = 0.001,
        max_frames: int = 1800,
    ) -> None:
        if baseline_fps <= 0 or burst_fps <= 0:
            raise ValueError("Sampling rates must be greater than zero")
        if burst_window < 0 or dedup_threshold < 0:
            raise ValueError("Sampling windows and deduplication threshold cannot be negative")
        if max_frames < 1:
            raise ValueError("max_frames must be at least one")
        self.baseline_fps = baseline_fps
        self.burst_fps = burst_fps
        self.burst_window = burst_window
        self.dedup_threshold = dedup_threshold
        self.max_frames = max_frames

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
        if duration <= 0:
            return []

        burst_windows = [
            (max(0.0, start - self.burst_window), min(duration, start + self.burst_window))
            for start, _scene_duration in scene_cuts
            if 0 <= start < duration
        ]
        burst_timestamps: set[float] = set()
        for start, end in burst_windows:
            timestamp = start
            while timestamp < end:
                burst_timestamps.add(round(timestamp, 3))
                timestamp += 1.0 / self.burst_fps

        # Baseline samples outside burst windows preserve broad coverage while
        # allowing the configured high-rate samples to survive deduplication.
        baseline_timestamps: set[float] = set()
        t = 0.0
        while t < duration:
            if not any(start <= t < end for start, end in burst_windows):
                baseline_timestamps.add(round(t, 3))
            t += 1.0 / self.baseline_fps

        boundary_timestamps = {
            round(start, 3) for start, _scene_duration in scene_cuts if 0 <= start < duration
        }
        candidates = sorted(burst_timestamps | baseline_timestamps | boundary_timestamps)

        if not candidates:
            return []

        deduped = [candidates[0]]
        for timestamp in candidates[1:]:
            if timestamp - deduped[-1] >= self.dedup_threshold:
                deduped.append(timestamp)

        if len(deduped) <= self.max_frames:
            return deduped

        # Keep scene boundaries first, then sample the remaining timeline
        # uniformly so long or cut-heavy sources cannot exceed the decode
        # budget. If there are more cuts than the budget, retain a uniform
        # subset of boundaries rather than returning an unbounded list.
        mandatory = sorted(boundary_timestamps)
        if len(mandatory) > self.max_frames:
            return self._evenly_spaced(mandatory, self.max_frames)

        remaining = self.max_frames - len(mandatory)
        optional = [timestamp for timestamp in deduped if timestamp not in boundary_timestamps]
        return sorted(set(mandatory + self._evenly_spaced(optional, remaining)))

    @staticmethod
    def _evenly_spaced(timestamps: list[float], count: int) -> list[float]:
        if count <= 0 or not timestamps:
            return []
        if count >= len(timestamps):
            return timestamps
        if count == 1:
            return [timestamps[len(timestamps) // 2]]
        indices = {
            round(index * (len(timestamps) - 1) / (count - 1))
            for index in range(count)
        }
        return [timestamps[index] for index in sorted(indices)]

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
