from __future__ import annotations

import cv2
import numpy as np

from kove_engine.types import FrameData, MotionLevel, MotionResult


class MotionAnalyzer:
    def __init__(
        self,
        static_threshold: float = 0.02,
        low_threshold: float = 0.08,
        medium_threshold: float = 0.20,
    ) -> None:
        self.static_threshold = static_threshold
        self.low_threshold = low_threshold
        self.medium_threshold = medium_threshold

    def analyze(self, frame: FrameData) -> MotionResult:
        """Compute motion level by comparing with previous frame."""
        if frame.prev_frame_path is None:
            return MotionResult(motion_level=MotionLevel.STATIC, raw_score=0.0)

        current = self._load_grayscale(frame.image_path)
        previous = self._load_grayscale(frame.prev_frame_path)

        diff = cv2.absdiff(current, previous)
        score = float(np.mean(diff)) / 255.0

        level = self._classify(score)
        return MotionResult(motion_level=level, raw_score=score)

    def _load_grayscale(self, path: str) -> np.ndarray:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise ValueError(f"Could not load image: {path}")
        return cv2.resize(img, (64, 64))

    def _classify(self, score: float) -> MotionLevel:
        if score < self.static_threshold:
            return MotionLevel.STATIC
        elif score < self.low_threshold:
            return MotionLevel.LOW
        elif score < self.medium_threshold:
            return MotionLevel.MEDIUM
        else:
            return MotionLevel.HIGH
