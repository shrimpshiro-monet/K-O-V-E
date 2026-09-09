from unittest.mock import patch, MagicMock

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


def test_frame_sampler_deduplicates():
    sampler = FrameSampler(baseline_fps=1.5, burst_fps=10, burst_window=2.0, dedup_threshold=0.5)
    timestamps = sampler._compute_timestamps(
        duration=10.0, scene_cuts=[(5.0, 1.0)]
    )
    for i in range(len(timestamps) - 1):
        assert timestamps[i + 1] - timestamps[i] >= 0.5 - 1e-6


def test_frame_sampler_extracts_frames():
    sampler = FrameSampler()
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        result = sampler.sample("/fake/video.mp4", [(0.0, 5.0)])

    assert isinstance(result, list)
    assert all(isinstance(r, tuple) and len(r) == 2 for r in result)
