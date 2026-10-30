from unittest.mock import MagicMock, patch

import pytest

from kove_engine.analyzers.frame_sampler import FrameSampler


def test_frame_sampler_generates_baseline_timestamps():
    sampler = FrameSampler(baseline_fps=1.5, burst_fps=10, burst_window=2.0)
    timestamps = sampler._compute_timestamps(
        duration=10.0, scene_cuts=[(3.0, 1.0), (7.0, 1.0)]
    )
    assert len(timestamps) > 10
    assert all(isinstance(t, float) for t in timestamps)


def test_frame_sampler_generates_burst_timestamps():
    sampler = FrameSampler(baseline_fps=1.5, burst_fps=10, burst_window=2.0)
    timestamps = sampler._compute_timestamps(
        duration=10.0, scene_cuts=[(5.0, 1.0)]
    )
    burst_times = [t for t in timestamps if 3.0 <= t <= 7.0]
    assert len(burst_times) > 5
    assert any(
        0.09 <= right - left <= 0.11
        for left, right in zip(burst_times, burst_times[1:])
    )


def test_frame_sampler_deduplicates_nearly_identical_timestamps():
    sampler = FrameSampler(baseline_fps=1.5, burst_fps=10, burst_window=2.0)
    timestamps = sampler._compute_timestamps(
        duration=10.0, scene_cuts=[(5.0, 1.0)]
    )
    for i in range(len(timestamps) - 1):
        assert timestamps[i + 1] - timestamps[i] >= 0.001 - 1e-6


def test_frame_sampler_respects_frame_budget_and_preserves_boundaries():
    sampler = FrameSampler(max_frames=8)
    timestamps = sampler._compute_timestamps(
        duration=30.0, scene_cuts=[(5.0, 1.0), (15.0, 1.0), (25.0, 1.0)]
    )
    assert len(timestamps) <= 8
    assert {5.0, 15.0, 25.0}.issubset(set(timestamps))


def test_frame_sampler_rejects_invalid_rates():
    with pytest.raises(ValueError, match="Sampling rates"):
        FrameSampler(baseline_fps=0)


def test_frame_sampler_extracts_frames():
    sampler = FrameSampler()
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        result = sampler.sample("/fake/video.mp4", [(0.0, 5.0)])

    assert isinstance(result, list)
    assert all(isinstance(r, tuple) and len(r) == 2 for r in result)
