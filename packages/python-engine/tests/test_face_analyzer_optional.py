"""Face detection must be optional: a missing or incompatible mediapipe degrades
to zero faces instead of taking down the analysis pipeline.

mediapipe lives outside the core install (see requirements-faces.txt), so these
paths run in the default environment rather than only in a special one.
"""

import builtins
import importlib
import logging
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from kove_engine.analyzers import face_analyzer
from kove_engine.analyzers.face_analyzer import FaceAnalyzer

MOD = "kove_engine.analyzers.face_analyzer"


class _BlockedImporter:
    """Context manager that makes `import mediapipe` raise ImportError."""

    def __enter__(self):
        self._real = builtins.__import__

        def fake(name, *args, **kwargs):
            if name == "mediapipe" or name.startswith("mediapipe."):
                raise ImportError("No module named 'mediapipe'")
            return self._real(name, *args, **kwargs)

        builtins.__import__ = fake
        return self

    def __exit__(self, *exc):
        builtins.__import__ = self._real
        return False


def test_module_imports_and_degrades_when_mediapipe_is_missing():
    """The guard is around the import, so a mediapipe-less install still imports."""
    with _BlockedImporter():
        reloaded = importlib.reload(face_analyzer)
        try:
            assert reloaded.mp is None
            analyzer = reloaded.FaceAnalyzer()
            assert analyzer.available is False
        finally:
            importlib.reload(face_analyzer)


def test_no_backend_returns_zero_faces_without_touching_the_image():
    with patch(f"{MOD}.mp", None), patch(f"{MOD}.cv2") as mock_cv2:
        analyzer = FaceAnalyzer()
        assert analyzer.available is False
        result = analyzer.analyze("/fake/frame.jpg")

    assert result.face_count == 0
    assert result.has_talking_head is False
    assert result.face_positions == []
    # No backend means no decode work either, not a silent read of every frame.
    mock_cv2.imread.assert_not_called()


def test_missing_backend_warns_once_at_construction():
    with patch(f"{MOD}.mp", None):
        with patch.object(face_analyzer.logger, "warning") as warn:
            analyzer = FaceAnalyzer()
            analyzer.analyze("/fake/a.jpg")
            analyzer.analyze("/fake/b.jpg")

    assert warn.call_count == 1
    assert "mediapipe is not installed" in warn.call_args[0][0]
    assert "requirements-faces.txt" in warn.call_args[0][0]


def test_mediapipe_without_the_solutions_api_degrades_instead_of_raising():
    """mediapipe 1.x dropped mp.solutions; that version mismatch must not crash
    the whole pipeline on construction."""
    # A plain namespace, not a MagicMock: MagicMock would invent mp.solutions.
    fake_mp = SimpleNamespace()
    with patch(f"{MOD}.mp", fake_mp):
        with patch.object(face_analyzer.logger, "warning") as warn:
            analyzer = FaceAnalyzer()
            result = analyzer.analyze("/fake/frame.jpg")

    assert analyzer.available is False
    assert result.face_count == 0
    assert any("Tasks API" in call.args[0] for call in warn.call_args_list)


def test_available_when_a_backend_can_be_built():
    with patch(f"{MOD}.mp") as mock_mp:
        analyzer = FaceAnalyzer()
        assert analyzer.available is True
    assert mock_mp.solutions.face_detection.FaceDetection.called


@pytest.mark.parametrize("confidence", [0.3, 0.5, 0.9])
def test_construction_options_reach_the_backend(confidence):
    with patch(f"{MOD}.mp") as mock_mp:
        FaceAnalyzer(min_detection_confidence=confidence, model_selection=1)

    assert mock_mp.solutions.face_detection.FaceDetection.call_args.kwargs == {
        "model_selection": 1,
        "min_detection_confidence": confidence,
    }


def test_pipeline_constructs_without_face_backend():
    """The orchestrator wires FaceAnalyzer unconditionally; it must still build."""
    from kove_engine.orchestrator import Orchestrator

    with patch(f"{MOD}.mp", None):
        orchestrator = Orchestrator()

    assert orchestrator.face_analyzer.available is False


def test_degradation_is_logged_at_warning_level(caplog):
    with patch(f"{MOD}.mp", None):
        with caplog.at_level(logging.WARNING):
            FaceAnalyzer()

    assert any("face detection is disabled" in r.message for r in caplog.records)


def test_degraded_result_is_still_a_valid_result_object():
    from kove_engine.types import FaceResult

    with patch(f"{MOD}.mp", None):
        result = FaceAnalyzer().analyze("ignored.jpg")

    assert isinstance(result, FaceResult)
