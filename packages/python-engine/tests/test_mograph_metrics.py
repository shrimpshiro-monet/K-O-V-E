from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from kove_engine.mograph_metrics import (
    CONFIG_VERSION,
    TIMELINE_VERSION,
    MaskRegion,
    MeasurementConfig,
    TrimSpec,
    _bucket_means,
    _low_motion_runs,
    build_cut_filter,
    build_motion_filter,
    dedupe_cuts,
    evaluate_scene_thresholds,
    find_burst_windows,
    load_config,
    measure_scene_metrics,
    measure_video,
    parse_config,
    parse_timeline,
)

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def _measurement() -> MeasurementConfig:
    return MeasurementConfig(
        sample_fps=6,
        frame_width=96,
        frame_height=54,
        scene_threshold=0.25,
        cut_dedupe_seconds=0.1,
        ignore_cuts_before_seconds=0.1,
        low_motion_floor=5.0,
        burst_window_seconds=1.0,
        burst_step_seconds=0.1,
    )


def _config_payload(video_path: Path, trim_start: float = 0.5, trim_end: float = 2.5) -> dict:
    return {
        "version": CONFIG_VERSION,
        "measurement": {
            "sampleFps": 6,
            "frameWidth": 96,
            "frameHeight": 54,
            "sceneThreshold": 0.25,
            "cutDedupeSeconds": 0.1,
            "ignoreCutsBeforeSeconds": 0.1,
            "lowMotionFloor": 5.0,
            "burstWindowSeconds": 1.0,
            "burstStepSeconds": 0.1,
        },
        "thresholds": {
            "editMeanMotion": {"min": 31, "max": 55},
            "first4sMeanMotion": {"min": 25},
            "first4sHardCuts": {"max": 0},
            "burst": {
                "minCutsPerSecond": 2,
                "minDurationSeconds": 1,
                "startFraction": 0.25,
                "endFraction": 0.8,
            },
            "maxStaticCompositionSeconds": {"max": 1.0},
            "hold": {
                "count": 1,
                "durationSeconds": {"min": 1.5, "max": 2.5},
                "startFraction": 0.75,
            },
        },
        "videos": [
            {
                "id": "reference",
                "role": "reference",
                "path": str(video_path),
                "trim": {"startSeconds": trim_start, "endSeconds": trim_end},
                "maskRegions": [],
            },
            {
                "id": "output",
                "role": "output",
                "path": str(video_path),
                "trim": {"startSeconds": 0, "endSeconds": 3.0},
                "maskRegions": [],
            },
        ],
    }


def test_dedupe_cuts_keeps_first_of_a_near_duplicate() -> None:
    assert dedupe_cuts([1.0, 1.04, 1.09, 1.2], 0.1, 0.0) == [1.0, 1.2]


def test_dedupe_cuts_ignores_trim_boundary_candidate() -> None:
    assert dedupe_cuts([0.056, 2.0], 0.1, 0.1) == [2.0]


def test_bucket_means_assign_differences_to_frame_centers() -> None:
    means, samples = _bucket_means(np.arange(1, 13, dtype=np.float32), 6)
    assert means == [3.5, 9.5]
    assert samples == [6, 6]


def test_low_motion_runs_report_partial_buckets() -> None:
    runs = _low_motion_runs([1.0, 1.0, 10.0, 1.0], [6, 6, 6, 3], 6, 5.0)
    assert runs == (
        {
            "startSeconds": 0.0,
            "endSeconds": 2.0,
            "durationSeconds": 2.0,
            "meanMotion": 1.0,
        },
        {
            "startSeconds": 3.0,
            "endSeconds": 3.5,
            "durationSeconds": 0.5,
            "meanMotion": 1.0,
        },
    )


def test_find_burst_windows_merges_a_dense_cut_run() -> None:
    cuts = (2.0, 2.4, 2.8, 3.2, 3.6, 4.0, 4.4, 4.8, 5.2)
    windows = find_burst_windows(cuts, duration=8.0, min_density=2.0, window=1.0, step=0.1)

    assert len(windows) == 1
    assert windows[0]["startSeconds"] <= 2.0
    assert windows[0]["endSeconds"] >= 5.2
    assert windows[0]["durationSeconds"] >= 3.0


def test_filters_include_trim_mask_sampling_and_scene_selection() -> None:
    masks = (MaskRegion(x=0.875, y=0.86, width=0.125, height=0.14, label="corner"),)
    trim = TrimSpec(start_seconds=0.5, end_seconds=19.3)
    motion = build_motion_filter(trim, masks, _measurement())
    cuts = build_cut_filter(trim, masks, _measurement())

    assert "trim=start=0.5:end=19.3" in motion
    assert "setpts=PTS-STARTPTS" in motion
    assert "drawbox=x=iw*0.875:y=ih*0.86:w=iw*0.125:h=ih*0.14" in motion
    assert "fps=6" in motion
    assert "scale=96:54" in motion
    assert "format=gray" in motion
    assert "select='gt(scene,0.25)'" in cuts
    assert "showinfo" in cuts


def test_parse_config_reads_thresholds_from_json(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(_config_payload(tmp_path / "video.mp4")), encoding="utf-8")

    config = load_config(path)

    assert config.version == CONFIG_VERSION
    assert config.measurement.sample_fps == 6
    assert config.measurement.frame_width == 96
    assert config.thresholds.edit_mean_motion_min == 31
    assert config.thresholds.edit_mean_motion_max == 55
    assert config.thresholds.hold_max_duration_seconds == 2.5
    assert [video.role for video in config.videos] == ["reference", "output"]


def test_repository_baseline_config_is_valid() -> None:
    config_path = (
        Path(__file__).resolve().parents[3]
        / "evaluation-files"
        / "mograph-baseline"
        / "config.json"
    )
    config = load_config(config_path)

    reference = next(video for video in config.videos if video.role == "reference")
    output = next(video for video in config.videos if video.role == "output")
    assert reference.trim.start_seconds == 0.5
    assert reference.trim.end_seconds == 19.3
    assert len(reference.mask_regions) == 2
    assert output.trim.start_seconds == 0
    assert output.trim.end_seconds == 28.0


def test_parse_config_rejects_mask_outside_the_frame() -> None:
    payload = _config_payload(Path("video.mp4"))
    payload["videos"][0]["maskRegions"] = [{"x": 0.9, "y": 0, "width": 0.2, "height": 0.1}]

    with pytest.raises(ValueError, match="must stay inside the frame"):
        parse_config(payload)


def test_parse_config_requires_one_reference_and_one_output() -> None:
    payload = _config_payload(Path("video.mp4"))
    payload["videos"].append(
        {
            "id": "second-output",
            "role": "output",
            "path": "video.mp4",
            "trim": {"startSeconds": 0, "endSeconds": 3.0},
            "maskRegions": [],
        }
    )

    with pytest.raises(ValueError, match="exactly one video with role 'output'"):
        parse_config(payload)


@pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="ffmpeg and ffprobe are required")
def test_measure_video_handles_trim_and_known_cuts(tmp_path: Path) -> None:
    video = tmp_path / "three-colors.mp4"
    _write_three_color_video(video)
    config = parse_config(_config_payload(video))

    metrics = measure_video(config.videos[0], tmp_path, config)

    assert metrics.effective.duration_seconds == pytest.approx(2.0, abs=0.02)
    assert len(metrics.cuts.times) == 2
    assert metrics.cuts.times[0] == pytest.approx(0.5, abs=0.2)
    assert metrics.cuts.times[1] == pytest.approx(1.5, abs=0.2)
    assert metrics.motion.mean > 10
    assert metrics.cuts.longest_shot_seconds == pytest.approx(1.0, abs=0.2)


def _write_three_color_video(path: Path) -> None:
    command = [
        FFMPEG or "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=320x180:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=30:d=1",
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-g",
        "30",
        "-bf",
        "0",
        "-frames:v",
        "90",
        str(path),
    ]
    subprocess.run(command, check=True, capture_output=True)


def _timeline_payload() -> dict:
    def layer(
        layer_id: str,
        keyframes: int,
        moves: list[str],
        role: str,
        end: float = 10,
        start: float = 0,
    ) -> dict:
        return {
            "id": layer_id,
            "role": role,
            "startSeconds": start,
            "endSeconds": end,
            "keyframes": keyframes,
            "moves": moves,
        }

    return {
        "version": TIMELINE_VERSION,
        "durationSeconds": 10,
        "scenes": [
            {
                "id": "page-hook",
                "startSeconds": 0,
                "endSeconds": 6,
                "composed": True,
                "layers": [
                    layer("background", 2, [], "background", 6),
                    layer("headline", 0, [], "headline", 6),
                    layer("photo-1", 0, ["slow-push"], "photo", 6),
                ],
            },
            {
                "id": "hold",
                "startSeconds": 6,
                "endSeconds": 8,
                "composed": True,
                "hold": True,
                "layers": [layer("hold-photo", 0, [], "photo", 8, 6)],
            },
            {
                "id": "raw-clip",
                "startSeconds": 8,
                "endSeconds": 10,
                "composed": False,
                "layers": [layer("footage", 3, [], "footage", 10, 8)],
            },
        ],
    }


def test_parse_timeline_reads_composed_layers_and_hold() -> None:
    timeline = parse_timeline(_timeline_payload())

    assert timeline.version == TIMELINE_VERSION
    assert len(timeline.scenes) == 3
    assert timeline.scenes[0].composed is True
    assert timeline.scenes[2].hold is False
    assert timeline.scenes[0].layers[2].has_motion is True


def test_parse_config_reads_scene_thresholds_and_timeline(tmp_path: Path) -> None:
    payload = _config_payload(tmp_path / "video.mp4")
    payload["thresholds"]["composedSceneCoverage"] = {"min": 0.65}
    payload["thresholds"]["shortShots"] = {"maxRatio": 0.05, "shotSeconds": 0.2}
    payload["thresholds"]["freezeTestMotion"] = {"minLayerMotionRatio": 0.9}
    payload["timeline"] = {"path": "timeline.json", "composedMinLayers": 2}

    config = parse_config(payload)

    assert config.thresholds.composed_scene_coverage_min == 0.65
    assert config.thresholds.short_shot_max_ratio == 0.05
    assert config.thresholds.short_shot_seconds == 0.2
    assert config.thresholds.freeze_test_min_layer_motion_ratio == 0.9
    assert config.timeline is not None
    assert config.timeline.path == "timeline.json"
    assert config.timeline.composed_min_layers == 2


def test_scene_metrics_cover_composed_layers_and_short_shots(tmp_path: Path) -> None:
    payload = _config_payload(tmp_path / "video.mp4")
    payload["timeline"] = {"path": "timeline.json", "composedMinLayers": 3}
    config = parse_config(payload)
    timeline = parse_timeline(_timeline_payload())
    video = SimpleNamespace(
        effective=SimpleNamespace(duration_seconds=10.0),
        cuts=SimpleNamespace(times=(2.0, 4.0, 9.9)),
    )

    scene = measure_scene_metrics(video, config, timeline)

    assert scene.composed_scene_coverage == pytest.approx(0.6)
    assert scene.short_shots == 1
    assert scene.total_shots == 4
    assert scene.short_shot_ratio == pytest.approx(0.25)
    assert scene.moving_layers == 2
    assert scene.total_layers == 3
    assert scene.freeze_test_layer_motion_ratio == pytest.approx(2 / 3)


def test_scene_thresholds_fail_raw_clip_edit_without_timeline(tmp_path: Path) -> None:
    payload = _config_payload(tmp_path / "video.mp4")
    config = parse_config(payload)
    video = SimpleNamespace(
        effective=SimpleNamespace(duration_seconds=10.0),
        cuts=SimpleNamespace(times=(0.1, 0.2, 3.0)),
    )

    findings = {finding["id"]: finding for finding in evaluate_scene_thresholds(video, config, None)}

    assert findings["composed-scene-coverage"]["passed"] is False
    assert findings["short-shots"]["passed"] is False
    assert findings["freeze-test-motion"]["passed"] is False


def test_parse_timeline_rejects_scene_outside_duration() -> None:
    payload = _timeline_payload()
    payload["scenes"][0]["endSeconds"] = 11

    with pytest.raises(ValueError, match="inside durationSeconds"):
        parse_timeline(payload)
