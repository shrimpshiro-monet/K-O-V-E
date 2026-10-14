"""Tests for the measurement layer.

These exist because a wrong assumption about an upstream contract produced
plausible-looking numbers rather than an error: `SceneDetector.detect` returns
`(start_time, duration)`, the harness read the second element as an end time, and
the scorecard reported a median shot length of -26.9 beats. Nothing crashed; the
numbers were simply wrong. So the contract is pinned here.
"""

import inspect
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kove_eval import metrics, repo  # noqa: E402


class TestEngineShotContract:
    def test_detect_returns_start_and_duration(self):
        """The engine's contract, asserted against the engine itself."""
        repo.ensure_engine_importable()
        from kove_engine.analyzers.scene_detector import SceneDetector

        doc = inspect.getdoc(SceneDetector.detect) or ""
        assert "start_time, duration" in doc, (
            "SceneDetector.detect changed its return contract; metrics.py reads it "
            "as (start, duration) and must be updated together"
        )

    def test_spans_as_ranges_uses_duration_not_end(self):
        spans = [(0.0, 1.0), (1.0, 0.5), (1.5, 2.0)]
        assert metrics.spans_as_ranges(spans) == [(0.0, 1.0), (1.0, 1.5), (1.5, 3.5)]

    def test_shot_lengths_reads_the_second_element(self):
        spans = [(0.0, 1.0), (1.0, 0.5), (1.5, 2.0)]
        assert metrics.shot_lengths(spans).tolist() == [1.0, 0.5, 2.0]

    def test_shot_lengths_never_go_negative(self):
        """A negative duration is an upstream bug; it must not propagate as one."""
        spans = [(1.0, -0.5), (0.5, 2.0)]
        assert (metrics.shot_lengths(spans) >= 0).all()


class TestBeatAlignment:
    def test_none_ratio_when_no_cuts_are_covered(self):
        # Cuts outside the measured span are excluded, not counted as misses.
        result = metrics.beat_alignment([100.0, 101.0], [1.0, 2.0, 3.0])
        assert result.evaluated == 0
        assert result.on_beat_ratio is None

    def test_rejects_offsets_beyond_the_tolerance(self):
        beats = [float(x) for x in range(10)]
        on = metrics.beat_alignment([1.0, 2.0, 3.0], beats)
        off = metrics.beat_alignment([1.2, 2.2, 3.2], beats)
        assert on.on_beat_ratio == 1.0
        assert off.on_beat_ratio == 0.0

    def test_offset_is_signed(self):
        late = metrics.beat_alignment([1.02, 2.02], [1.0, 2.0, 3.0])
        early = metrics.beat_alignment([0.98, 1.98], [1.0, 2.0, 3.0])
        assert late.median_offset_ms > 0
        assert early.median_offset_ms < 0


class TestDistributionDistance:
    def test_identical_distributions_have_zero_distance(self):
        a = np.asarray([1.0, 2.0, 3.0])
        assert metrics.distribution_distance(a, a)["emd"] == pytest.approx(0.0, abs=1e-9)

    def test_constant_shift_matches_the_shift(self):
        a = np.asarray([1.0] * 4)
        b = np.asarray([2.0] * 4)
        assert metrics.distribution_distance(a, b)["emd"] == pytest.approx(1.0, abs=0.05)


class TestColor:
    def test_delta_e_zero_for_identical_frames(self):
        frame = np.full((16, 16, 3), 120, dtype=np.uint8)
        lab = metrics.bgr_to_lab(frame)
        assert np.allclose(metrics.delta_e_2000_pixels(lab, lab), 0.0, atol=1e-6)

    def test_one_channel_step_is_below_the_notice_threshold(self):
        """CIEDE2000's point: ΔE 1 is roughly the threshold of noticing."""
        a = np.full((8, 8, 3), 100, dtype=np.uint8)
        b = a.copy()
        b[..., 0] = 101
        delta = metrics.delta_e_2000_pixels(metrics.bgr_to_lab(a), metrics.bgr_to_lab(b))
        assert delta.mean() < 2.0

    def test_strong_grade_scores_far_above_noticeable(self):
        a = np.full((8, 8, 3), 100, dtype=np.uint8)
        b = np.full((8, 8, 3), 160, dtype=np.uint8)
        delta = metrics.delta_e_2000_pixels(metrics.bgr_to_lab(a), metrics.bgr_to_lab(b))
        assert delta.mean() > 20.0


class TestDucking:
    def test_depth_is_positive_when_the_bed_drops_under_speech(self):
        rate = 8000
        times = np.arange(0, 4.0, 1 / rate)
        tone = (0.5 * np.sin(2 * np.pi * 80 * times)).astype(np.float32)  # low band
        windows = [(2.0, 3.0)]
        ducked = tone.copy()
        ducked[int(2.0 * rate) : int(3.0 * rate)] *= 10 ** (-12 / 20)

        from kove_eval.media import write_wav

        with tempfile.TemporaryDirectory() as tmp:
            plain = Path(tmp) / "plain.wav"
            duck = Path(tmp) / "duck.wav"
            write_wav(tone, rate, plain)
            write_wav(ducked, rate, duck)
            plain_depth = metrics.ducking_depth_db(plain, windows)
            ducked_depth = metrics.ducking_depth_db(duck, windows)

        assert plain_depth is not None and ducked_depth is not None
        assert abs(plain_depth) < 2.0
        assert ducked_depth > 8.0
