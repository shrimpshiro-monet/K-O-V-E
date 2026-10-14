"""The cut reader must be provably able to find a cut, and to find it shifted.

A reader that reports "no bias" because it cannot see bias is worse than no
reader. These tests build files with cuts at known frame indices and require the
reader to name those indices exactly — including when the file has been shifted
by a known number of frames.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from kove_eval import cutreader
from kove_eval.media import write_video_from_frames

FPS = 25.0


def _fixture(path: Path, cut_frames: list[int], total: int = 100) -> Path:
    """Frames that are flat until a cut frame, then flat at a new level.

    Flat shots, so the only frame-to-frame difference in the file is the cut
    itself: the reader cannot be flattered by motion it happens to notice.
    """
    frames = []
    level = 20
    cuts = set(cut_frames)
    for index in range(total):
        if index in cuts:
            level = 40 if level == 20 else 20
        frames.append(np.full((180, 320, 3), level, dtype=np.uint8))
    write_video_from_frames(frames, FPS, path)
    return path


def test_reads_a_cut_where_it_is(tmp_path: Path) -> None:
    video = _fixture(tmp_path / "exact.mp4", [20, 40])
    plan = [20 / FPS, 40 / FPS]

    readings = cutreader.read_cuts(video, plan)

    assert [r.frame_index for r in readings] == [20, 40]
    assert all(abs(r.delta_seconds) < 1e-6 for r in readings)


def test_reads_a_cut_that_is_one_frame_off(tmp_path: Path) -> None:
    """The case the whole sub-step exists for: a renderer that is late."""
    video = _fixture(tmp_path / "late.mp4", [21, 41])
    plan = [20 / FPS, 40 / FPS]

    readings = cutreader.read_cuts(video, plan)

    assert [r.frame_index for r in readings] == [21, 41]
    for reading in readings:
        assert abs(reading.delta_seconds - 1 / FPS) < 1e-6


def test_reads_a_cut_that_is_early(tmp_path: Path) -> None:
    """A reader that can only ever report "late" would flatter the renderer."""
    video = _fixture(tmp_path / "early.mp4", [19, 39])
    plan = [20 / FPS, 40 / FPS]

    readings = cutreader.read_cuts(video, plan)

    assert [r.frame_index for r in readings] == [19, 39]
    assert all(reading.delta_seconds < 0 for reading in readings)


def test_finds_a_cut_inside_a_shot_that_is_moving(tmp_path: Path) -> None:
    """Real footage moves. A cut has to stand out against that, not against flat grey."""
    frames = []
    rng = np.random.default_rng(3)
    phase = 0.0
    for index in range(100):
        # A drifting gradient: every frame differs from the last, everywhere.
        phase += 2.0
        ramp = np.linspace(0, 1, 320)[None, :] * 60.0
        base = np.tile(ramp + phase, (180, 1))
        frame = np.stack([base, base, base], axis=-1)
        if index >= 50:
            frame = frame * 0.4 + 80.0
        frame += rng.normal(0, 1.5, frame.shape)
        frames.append(np.clip(frame, 0, 255).astype(np.uint8))
    video = tmp_path / "moving.mp4"
    write_video_from_frames(frames, FPS, video)

    readings = cutreader.read_cuts(video, [50 / FPS])

    assert readings[0].frame_index == 50


def test_reports_the_frame_grid_share_of_the_delta(tmp_path: Path) -> None:
    """A cut planned between frames cannot be shown on the frame before it.

    This is the arithmetic that must not be mistaken for renderer lateness: a
    plan time of 0.02 s at 25 fps can only first appear at frame 1 (0.04 s), so
    a perfectly faithful renderer reports +20 ms.
    """
    video = _fixture(tmp_path / "quantised.mp4", [1])
    readings = cutreader.read_cuts(video, [0.02])

    assert readings[0].frame_index == 1
    assert readings[0].delta_seconds == 1 / FPS - 0.02
    # And the prediction accounts for all of it.
    assert abs(readings[0].delta_seconds - readings[0].predicted_quantisation_delta_seconds) < 1e-9


def test_summary_separates_the_grid_from_the_renderer(tmp_path: Path) -> None:
    video = _fixture(tmp_path / "mixed.mp4", [21, 41, 61])
    readings = cutreader.read_cuts(video, [20 / FPS, 40 / FPS, 60 / FPS])

    summary = cutreader.summarise(readings)

    assert summary["count"] == 3
    # Late by exactly one frame, and the grid predicts none of it: all plan
    # times sit on frame boundaries here.
    assert abs(summary["delta_median_ms"] - 40.0) < 1e-6
    assert abs(summary["predicted_median_ms"]) < 1e-6
    assert abs(summary["residual_median_ms"] - 40.0) < 1e-6


def test_an_empty_plan_is_not_an_error(tmp_path: Path) -> None:
    video = _fixture(tmp_path / "quiet.mp4", [])
    assert cutreader.read_cuts(video, []) == []
    assert cutreader.summarise([]) == {"count": 0}
