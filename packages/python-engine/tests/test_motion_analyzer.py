import tempfile
from pathlib import Path

import cv2
import numpy as np

from kove_engine.analyzers.motion_analyzer import MotionAnalyzer
from kove_engine.types import FrameData, MotionLevel


def _make_frame(path: str, color: int) -> None:
    """Create a solid-color test frame."""
    img = np.full((64, 64, 3), color, dtype=np.uint8)
    cv2.imwrite(path, img)


def test_static_frame_returns_static():
    analyzer = MotionAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame1 = str(Path(tmpdir) / "f1.jpg")
        frame2 = str(Path(tmpdir) / "f2.jpg")
        _make_frame(frame1, 128)
        _make_frame(frame2, 128)

        result = analyzer.analyze(
            FrameData(timestamp=1.0, image_path=frame2, prev_frame_path=frame1)
        )

    assert result.motion_level == MotionLevel.STATIC
    assert result.raw_score < 0.02


def test_high_motion_returns_high():
    analyzer = MotionAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame1 = str(Path(tmpdir) / "f1.jpg")
        frame2 = str(Path(tmpdir) / "f2.jpg")
        _make_frame(frame1, 0)
        _make_frame(frame2, 255)

        result = analyzer.analyze(
            FrameData(timestamp=1.0, image_path=frame2, prev_frame_path=frame1)
        )

    assert result.motion_level == MotionLevel.HIGH
    assert result.raw_score > 0.20


def test_no_previous_frame_returns_static():
    analyzer = MotionAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame = str(Path(tmpdir) / "f1.jpg")
        _make_frame(frame, 128)

        result = analyzer.analyze(
            FrameData(timestamp=0.0, image_path=frame)
        )

    assert result.motion_level == MotionLevel.STATIC
    assert result.raw_score == 0.0


def test_motion_level_thresholds():
    analyzer = MotionAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame1 = str(Path(tmpdir) / "f1.jpg")
        _make_frame(frame1, 100)

        for expected_level, color in [
            (MotionLevel.STATIC, 100),
            (MotionLevel.LOW, 110),
            (MotionLevel.MEDIUM, 130),
            (MotionLevel.HIGH, 200),
        ]:
            frame2 = str(Path(tmpdir) / "f2.jpg")
            _make_frame(frame2, color)
            result = analyzer.analyze(
                FrameData(timestamp=1.0, image_path=frame2, prev_frame_path=frame1)
            )
            assert result.motion_level == expected_level, (
                f"Expected {expected_level} for color {color}, got {result.motion_level}"
            )
