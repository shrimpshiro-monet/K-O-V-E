from pathlib import Path

import cv2
import numpy as np

from kove_engine.forensics import analyze_sampled_sequence


def _write_frame(path: Path, color: tuple[int, int, int], text: str = "") -> None:
    frame = np.full((90, 160, 3), color, dtype=np.uint8)
    if text:
        cv2.putText(frame, text, (8, 48), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    assert cv2.imwrite(str(path), frame)


def test_sequence_forensics_detects_cut_and_visual_evidence(tmp_path: Path) -> None:
    first = tmp_path / "first.jpg"
    second = tmp_path / "second.jpg"
    _write_frame(first, (20, 20, 20), "A")
    _write_frame(second, (220, 80, 20), "B")

    result = analyze_sampled_sequence(
        "missing-video.mp4",
        [(0.0, str(first)), (1.0, str(second))],
        2.0,
    )

    assert result["sampling"]["sampleCount"] == 2
    assert result["transitions"][0]["type"] == "hard-cut"
    assert result["metadata"]["available"] is False
    assert result["visualTreatment"]["description"] != "unknown"