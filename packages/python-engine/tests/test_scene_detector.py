"""Shot boundary detection.

These run against real video files written with cv2.VideoWriter, so the decode
path, the content score, the adaptive threshold and the scene assembly are all
exercised rather than mocked. That matters here: the previous tests only proved
that ffmpeg's stderr parsing worked, which is why two bugs survived — a hard
0.5s minimum scene length and a last scene that always claimed to last 10s.
"""

import cv2
import numpy as np
import pytest

from kove_engine.analyzers.scene_detector import FALLBACK_LAST_SCENE_SECONDS, SceneDetector

FPS = 25.0
SIZE = (160, 90)


def write_shots(path, shots, fps=FPS, size=SIZE):
    """Write a video from (frame_count, grey_value) shots joined by hard cuts."""
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    assert writer.isOpened(), "cv2 cannot encode video in this environment"
    try:
        for frames, value in shots:
            for _ in range(frames):
                writer.write(np.full((size[1], size[0], 3), value, np.uint8))
    finally:
        writer.release()
    return str(path)


def write_pan(path, frames=100, fps=FPS, size=SIZE):
    """A continuously scrolling gradient: constant motion, no cuts."""
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    try:
        ramp = np.linspace(0, 255, size[0]).astype(np.uint8)
        for i in range(frames):
            frame = np.roll(np.tile(ramp, (size[1], 1)), i * 2, axis=1)
            writer.write(cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR))
    finally:
        writer.release()
    return str(path)


def starts_and_durations(scenes):
    return [(round(s, 3), round(d, 3)) for s, d in scenes]


class TestHardCuts:
    def test_detects_cuts_at_known_times(self, tmp_path):
        path = write_shots(tmp_path / "a.mp4", [(25, 0), (25, 255), (25, 0), (25, 128)])

        scenes = SceneDetector().detect(path)

        assert starts_and_durations(scenes) == [
            (0.0, 1.0), (1.0, 1.0), (2.0, 1.0), (3.0, 1.0)
        ]

    def test_shots_shorter_than_the_old_half_second_floor_are_kept(self, tmp_path):
        """The regression this detector exists for.

        At 25fps these eight 6-frame shots are 0.24s each. The old
        `min_scene_duration=0.5` filter discarded every one of them, reporting a
        single scene for a reference that cuts eight times.
        """
        colours = [0, 255, 0, 255, 0, 128, 255, 60]
        path = write_shots(tmp_path / "fast.mp4", [(6, c) for c in colours])

        scenes = SceneDetector().detect(path)

        assert len(scenes) == 8
        durations = [round(d, 3) for _, d in scenes]
        assert durations == [0.24] * 8
        assert all(s < 0.5 for s in durations)

    def test_a_single_frame_flash_becomes_its_own_one_frame_scene(self, tmp_path):
        """Known limitation, asserted rather than hidden.

        Dropping the minimum scene length means a one-frame flash or strobe is
        reported as a 0.04s shot, because that is a real content discontinuity
        and nothing here distinguishes it from a deliberate one-frame insert.
        Suppressing it needs a persistence rule calibrated against real
        strobe-heavy footage; inventing one now would repeat the mistake that
        produced the 0.5s floor.
        """
        path = write_shots(tmp_path / "flash.mp4", [(20, 0), (1, 255), (20, 0)])

        scenes = SceneDetector().detect(path)

        assert starts_and_durations(scenes) == [(0.0, 0.8), (0.8, 0.04), (0.84, 0.8)]


class TestAdaptiveThreshold:
    def test_continuous_motion_is_not_a_cut(self, tmp_path):
        path = write_pan(tmp_path / "pan.mp4")

        scenes = SceneDetector().detect(path)

        assert len(scenes) == 1, starts_and_durations(scenes)

    def test_a_static_shot_is_one_scene(self, tmp_path):
        path = write_shots(tmp_path / "solid.mp4", [(50, 200)])

        scenes = SceneDetector().detect(path)

        assert starts_and_durations(scenes) == [(0.0, 2.0)]

    def test_low_threshold_is_flagged_as_a_probable_unit_mistake(self, caplog):
        with caplog.at_level("WARNING"):
            SceneDetector(adaptive_threshold=0.3)

        assert any("below 1.0" in r.message for r in caplog.records)


class TestLastScene:
    def test_last_scene_ends_at_the_decoded_length(self, tmp_path):
        """It used to be `start + 10.0`, which invented footage past the file."""
        path = write_shots(tmp_path / "a.mp4", [(25, 0), (25, 255)])

        scenes = SceneDetector().detect(path)

        assert starts_and_durations(scenes) == [(0.0, 1.0), (1.0, 1.0)]
        assert scenes[-1][0] + scenes[-1][1] == pytest.approx(2.0, abs=0.05)

    def test_caller_duration_closes_the_final_scene(self, tmp_path):
        """A container duration can exceed the frames a decoder returns."""
        path = write_shots(tmp_path / "short.mp4", [(25, 0), (25, 255)])

        scenes = SceneDetector().detect(path, duration=12.0)

        assert scenes[0] == (0.0, 1.0)
        assert scenes[-1][0] + scenes[-1][1] == pytest.approx(12.0)

    def test_cut_beyond_the_end_does_not_create_an_empty_trailing_scene(self):
        scenes = SceneDetector()._to_scenes([1.0, 5.0, 9.0], total_duration=5.0)

        assert starts_and_durations(scenes) == [(0.0, 1.0), (1.0, 4.0)]

    def test_zero_duration_yields_one_empty_scene_rather_than_a_crash(self):
        # `detect` never reaches this with a zero duration — it substitutes
        # FALLBACK_LAST_SCENE_SECONDS first — so this only pins the helper's
        # behaviour for callers that use it directly.
        scenes = SceneDetector()._to_scenes([], total_duration=0.0)

        assert scenes == [(0.0, 0.0)]


class TestSceneAssembly:
    def test_scenes_tile_the_video_without_gaps(self, tmp_path):
        path = write_shots(tmp_path / "a.mp4", [(25, 0), (25, 255), (25, 0), (25, 128)])

        scenes = SceneDetector().detect(path)

        for (start, duration), (next_start, _) in zip(scenes, scenes[1:]):
            assert start + duration == pytest.approx(next_start, abs=1e-6)
        assert scenes[0][0] == 0.0
        assert scenes[-1][0] + scenes[-1][1] == pytest.approx(4.0, abs=0.05)

    def test_duplicate_boundaries_do_not_create_empty_scenes(self):
        scenes = SceneDetector()._to_scenes([1.0, 1.0, 1.0, 2.0], total_duration=3.0)

        assert starts_and_durations(scenes) == [(0.0, 1.0), (1.0, 1.0), (2.0, 1.0)]


class TestFallbacks:
    def test_unreadable_file_returns_one_scene_instead_of_raising(self, tmp_path):
        broken = tmp_path / "broken.mp4"
        broken.write_bytes(b"this is not a video")

        scenes = SceneDetector().detect(str(broken))

        assert len(scenes) == 1
        assert scenes[0][1] > 0

    def test_missing_file_returns_one_scene_instead_of_raising(self, tmp_path):
        scenes = SceneDetector().detect(str(tmp_path / "nope.mp4"), duration=7.5)

        assert scenes == [(0.0, 7.5)]

    def test_missing_file_without_duration_uses_the_fallback_span(self, tmp_path):
        scenes = SceneDetector().detect(str(tmp_path / "nope.mp4"))

        assert scenes == [(0.0, FALLBACK_LAST_SCENE_SECONDS)]

    def test_ffmpeg_parser_keeps_short_shots_too(self):
        """The fallback must not silently reinstate the 0.5s filter."""
        stderr = "\n".join(
            f"[Parsed_showinfo_1 @ 0x1] n:{i} pts:{int(pts*1000)} pts_time:{pts}"
            for i, pts in enumerate([0.0, 0.24, 0.48, 0.72])
        )

        scenes = SceneDetector()._parse_timestamps(stderr, duration=1.0)

        assert len(scenes) == 4
        assert scenes[1][0] == 0.24

    def test_ffmpeg_parser_without_timestamps_reports_the_whole_video(self):
        scenes = SceneDetector()._parse_timestamps("no timestamps here", duration=4.0)

        assert scenes == [(0.0, 4.0)]
