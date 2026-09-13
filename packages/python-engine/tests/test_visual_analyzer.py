import tempfile
from pathlib import Path

import cv2
import numpy as np

from kove_engine.analyzers.visual_analyzer import VisualAnalyzer
from kove_engine.types import VisualResult


def _make_frame(path: str, color: tuple[int, int, int]) -> None:
    img = np.full((100, 100, 3), color, dtype=np.uint8)
    cv2.imwrite(path, img)


def test_dark_frame():
    analyzer = VisualAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame = str(Path(tmpdir) / "dark.jpg")
        _make_frame(frame, (10, 10, 10))
        result = analyzer.analyze(frame)
    assert isinstance(result, VisualResult)
    assert result.brightness < 0.3
    assert result.scene_setting == "dark"


def test_bright_frame():
    analyzer = VisualAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame = str(Path(tmpdir) / "bright.jpg")
        _make_frame(frame, (200, 200, 200))
        result = analyzer.analyze(frame)
    assert result.brightness > 0.5


def test_color_histogram_length():
    analyzer = VisualAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame = str(Path(tmpdir) / "frame.jpg")
        _make_frame(frame, (128, 64, 192))
        result = analyzer.analyze(frame)
    assert len(result.color_histogram) == 48


def test_dominant_colors():
    analyzer = VisualAnalyzer()
    with tempfile.TemporaryDirectory() as tmpdir:
        frame = str(Path(tmpdir) / "frame.jpg")
        _make_frame(frame, (255, 0, 0))
        result = analyzer.analyze(frame)
    assert len(result.dominant_colors) >= 1
    assert all(c.startswith("#") for c in result.dominant_colors)
