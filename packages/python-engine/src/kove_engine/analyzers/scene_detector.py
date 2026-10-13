from __future__ import annotations

import logging
import re
import subprocess
from collections import deque

import cv2
import numpy as np

logger = logging.getLogger(__name__)

TIMESTAMP_PATTERN = re.compile(r"pts_time:(\d+\.?\d*)")

# Scores are computed on a downscaled copy of each frame. A hard cut moves every
# pixel, so the score is barely affected while the cost drops by an order of
# magnitude — 1920x1080 frames are otherwise ~2 MPix of differencing per pair.
ANALYSIS_WIDTH = 160

# The last scene's end time is unknown until the stream ends. This is only used
# when neither the caller nor the decoder can supply a real duration.
FALLBACK_LAST_SCENE_SECONDS = 10.0


class SceneDetector:
    """Detect shot boundaries with an adaptive content threshold.

    The previous implementation shelled out to ffmpeg's `select=gt(scene,0.3)`,
    a fixed global threshold, and then discarded every boundary closer than 0.5s
    to the previous one. That floor is what made fast-cut references
    unanalysable: music-video and trailer references routinely cut every 0.2-0.4s,
    so their shot structure was collapsed into a fraction of the real cutting
    rate, and every metric derived from shot lengths and on-beat ratios
    inherited the distortion.

    This scores frame-to-frame content change (a hue/saturation/value
    comparison, scaled to 0-255 like PySceneDetect's ContentDetector) and marks
    a boundary when the score both clears an absolute floor and exceeds a
    multiple of its own recent rolling mean. The adaptive half is what keeps
    camera motion from reading as cuts: a pan raises the score, but so does the
    local baseline, so the ratio stays flat.

    There is no minimum scene length. That is deliberate — a 0.5s floor is what
    hid the cutting rate of fast-cut references — but it has a consequence worth
    knowing: a one-frame flash or strobe is reported as a one-frame scene. A
    persistence rule would suppress those, and adding one without real
    strobe-heavy footage to calibrate against is how the 0.5s floor got there.
    """

    def __init__(
        self,
        adaptive_threshold: float = 3.0,
        min_content_val: float = 15.0,
        rolling_window: int = 10,
        sample_step: int = 1,
    ) -> None:
        # A value below 1.0 cannot be a ratio worth using (it would mark every
        # frame a cut) and is almost certainly a leftover from the old
        # ffmpeg-score API, where the default was 0.3. Say so rather than
        # silently producing a nonsense edit.
        if 0.0 < adaptive_threshold < 1.0:
            logger.warning(
                "adaptive_threshold=%.2f is below 1.0; this parameter compares the "
                "content score against its own rolling mean, not the 0-1 ffmpeg scene "
                "score, so values under 1.0 mark nearly every frame as a cut. "
                "Did you mean the default 3.0?",
                adaptive_threshold,
            )

        self.adaptive_threshold = adaptive_threshold
        self.min_content_val = min_content_val
        self.rolling_window = max(1, rolling_window)
        self.sample_step = max(1, sample_step)

    def detect(self, video_path: str, duration: float = 0.0) -> list[tuple[float, float]]:
        """Return (start_time, duration) tuples covering the whole video.

        `duration` is the caller's best knowledge of the video length; it is used
        to close the final scene, which cannot be derived from the boundaries
        alone. When it is missing or zero the decoder's own measurement is used.
        """
        scenes, measured_duration = self._run_adaptive(video_path, duration)
        if scenes is not None:
            return scenes

        # cv2 could not decode this file — a codec it lacks, or a damaged
        # container. ffmpeg is more forgiving, so fall back to it before giving up.
        total_duration = duration if duration > 0 else measured_duration
        try:
            return self._run_ffmpeg(video_path, total_duration)
        except (FileNotFoundError, subprocess.CalledProcessError) as e:
            logger.warning(
                "Both the adaptive detector and ffmpeg failed (%s) — "
                "returning a single scene",
                e,
            )
            return [(0.0, total_duration if total_duration > 0 else FALLBACK_LAST_SCENE_SECONDS)]

    # -- adaptive detector ------------------------------------------------

    def _run_adaptive(
        self, video_path: str, duration: float
    ) -> tuple[list[tuple[float, float]] | None, float]:
        """Return (scenes, decoded_duration), or (None, 0.0) if the file will not open."""
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            capture.release()
            return None, 0.0

        fps = capture.get(cv2.CAP_PROP_FPS)
        if not fps or fps <= 0 or np.isnan(fps):
            logger.warning("Unreadable frame rate for %s — assuming 25 fps", video_path)
            fps = 25.0

        scores: list[tuple[float, float]] = []
        previous = None
        index = 0
        try:
            while True:
                ok, frame = capture.read()
                if not ok or frame is None:
                    break

                if index % self.sample_step == 0:
                    score_frame = self._prepare(frame)
                    if previous is not None:
                        scores.append((index / fps, self._content_score(previous, score_frame)))
                    previous = score_frame

                index += 1
        finally:
            capture.release()

        decoded_duration = index / fps if index else 0.0
        total_duration = duration if duration > 0 else decoded_duration
        if total_duration <= 0:
            total_duration = FALLBACK_LAST_SCENE_SECONDS

        cuts = self._select_cuts(scores)
        return self._to_scenes(cuts, total_duration), decoded_duration

    def _prepare(self, frame: np.ndarray) -> np.ndarray:
        """Downscale to a comparison width and convert once, so each frame is
        colour-converted a single time rather than on both sides of every pair."""
        height, width = frame.shape[:2]
        if width > ANALYSIS_WIDTH:
            scale = ANALYSIS_WIDTH / float(width)
            resized = (ANALYSIS_WIDTH, max(1, int(round(height * scale))))
            frame = cv2.resize(frame, resized, interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    def _content_score(self, previous: np.ndarray, current: np.ndarray) -> float:
        """Mean per-pixel HSV change, scaled to roughly 0-255 (PySceneDetect's convention)."""
        if previous.shape != current.shape:
            current = cv2.resize(current, (previous.shape[1], previous.shape[0]))

        # OpenCV encodes hue as 0-179; rescale it to 0-255 so hue, saturation and
        # value carry comparable weight instead of hue being half-counted.
        delta_h = np.abs(
            current[:, :, 0].astype(np.int16) - previous[:, :, 0].astype(np.int16)
        ).mean() * (255.0 / 179.0)
        delta_s = np.abs(
            current[:, :, 1].astype(np.int16) - previous[:, :, 1].astype(np.int16)
        ).mean()
        delta_v = np.abs(
            current[:, :, 2].astype(np.int16) - previous[:, :, 2].astype(np.int16)
        ).mean()

        return float((delta_h + delta_s + delta_v) / 3.0)

    def _select_cuts(self, scores: list[tuple[float, float]]) -> list[float]:
        history: deque[float] = deque(maxlen=self.rolling_window)
        cuts: list[float] = []

        for timestamp, score in scores:
            if history:
                baseline = sum(history) / len(history)
                # A cut must clear the absolute floor AND stand out against what
                # this stretch of video considers normal change. The floor stops
                # a near-static shot from cutting on noise around zero.
                if score >= self.min_content_val and score >= baseline * self.adaptive_threshold:
                    cuts.append(timestamp)
            history.append(score)

        return cuts

    def _to_scenes(self, cuts: list[float], total_duration: float) -> list[tuple[float, float]]:
        """Turn boundary timestamps into contiguous (start, duration) scenes.

        The final scene runs to the real end of the video. Previously it was
        `start + 10.0` unconditionally, which overstated short references by
        seconds and could invent footage past the end of the file.
        """
        boundaries = [0.0]
        for cut in sorted(cuts):
            if cut <= boundaries[-1]:
                continue
            if cut >= total_duration:
                # A boundary at or past the end leaves no scene after it.
                continue
            boundaries.append(cut)
        boundaries.append(max(total_duration, boundaries[-1]))

        scenes: list[tuple[float, float]] = []
        for i, start in enumerate(boundaries[:-1]):
            scenes.append((start, boundaries[i + 1] - start))
        return scenes

    # -- ffmpeg fallback --------------------------------------------------

    def _run_ffmpeg(self, video_path: str, duration: float) -> list[tuple[float, float]]:
        cmd = [
            "ffmpeg",
            "-i", video_path,
            "-vf", "select='gt(scene,0.3)',showinfo",
            "-f", "null",
            "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return self._parse_timestamps(result.stderr, duration)

    def _parse_timestamps(self, stderr: str, duration: float) -> list[tuple[float, float]]:
        raw_times = []
        for line in stderr.splitlines():
            match = TIMESTAMP_PATTERN.search(line)
            if match:
                raw_times.append(float(match.group(1)))

        if duration <= 0:
            duration = (
                FALLBACK_LAST_SCENE_SECONDS
                if not raw_times
                else raw_times[-1] + FALLBACK_LAST_SCENE_SECONDS
            )

        # No min_scene_duration filtering: the adaptive path dropped it and a
        # fallback that silently discarded short shots would reintroduce exactly
        # the distortion this detector exists to remove.
        return self._to_scenes(sorted(raw_times), duration)
