from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

CONFIG_VERSION = "kove.mograph.metrics.v1"
TIMELINE_VERSION = "kove.mograph.timeline.v1"
BASELINE_VERSION = "kove.mograph.baseline.v1"
COMPARISON_VERSION = "kove.mograph.comparison.v1"
TIMESTAMP_PATTERN = re.compile(r"pts_time:(\d+(?:\.\d+)?)")


@dataclass(frozen=True)
class MaskRegion:
    x: float
    y: float
    width: float
    height: float
    label: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


@dataclass(frozen=True)
class TrimSpec:
    start_seconds: float
    end_seconds: float | None


@dataclass(frozen=True)
class VideoSpec:
    id: str
    role: str
    path: str
    trim: TrimSpec
    mask_regions: tuple[MaskRegion, ...]


@dataclass(frozen=True)
class MeasurementConfig:
    sample_fps: float
    frame_width: int
    frame_height: int
    scene_threshold: float
    cut_dedupe_seconds: float
    ignore_cuts_before_seconds: float
    low_motion_floor: float
    burst_window_seconds: float
    burst_step_seconds: float


@dataclass(frozen=True)
class ThresholdConfig:
    edit_mean_motion_min: float | None
    edit_mean_motion_max: float | None
    first4s_mean_motion_min: float | None
    first4s_hard_cuts_max: int | None
    burst_min_cuts_per_second: float
    burst_min_duration_seconds: float
    burst_start_fraction: float
    burst_end_fraction: float
    max_static_composition_seconds: float
    hold_count: int
    hold_min_duration_seconds: float
    hold_max_duration_seconds: float
    hold_start_fraction: float
    composed_scene_coverage_min: float
    short_shot_max_ratio: float
    short_shot_seconds: float
    freeze_test_min_layer_motion_ratio: float


@dataclass(frozen=True)
class TimelineLayerSpec:
    id: str
    role: str
    start_seconds: float
    end_seconds: float
    keyframe_count: int
    moves: tuple[str, ...]

    @property
    def has_motion(self) -> bool:
        return self.keyframe_count > 0 or bool(self.moves)


@dataclass(frozen=True)
class TimelineSceneSpec:
    id: str
    start_seconds: float
    end_seconds: float
    composed: bool
    hold: bool
    layers: tuple[TimelineLayerSpec, ...]


@dataclass(frozen=True)
class TimelineSpec:
    version: str
    duration_seconds: float
    scenes: tuple[TimelineSceneSpec, ...]


@dataclass(frozen=True)
class TimelineConfig:
    path: str | None
    composed_min_layers: int


@dataclass(frozen=True)
class MetricsConfig:
    version: str
    measurement: MeasurementConfig
    thresholds: ThresholdConfig
    videos: tuple[VideoSpec, ...]
    timeline: TimelineConfig | None = None


@dataclass(frozen=True)
class VideoProbe:
    width: int
    height: int
    fps: float
    duration_seconds: float
    codec: str
    container: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "width": self.width,
            "height": self.height,
            "fps": round(self.fps, 3),
            "durationSeconds": round(self.duration_seconds, 3),
            "codec": self.codec,
            "container": self.container,
        }


@dataclass(frozen=True)
class EffectiveRange:
    start_seconds: float
    end_seconds: float
    duration_seconds: float
    source_duration_seconds: float
    trimmed: bool
    masks: tuple[MaskRegion, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "startSeconds": round(self.start_seconds, 3),
            "endSeconds": round(self.end_seconds, 3),
            "durationSeconds": round(self.duration_seconds, 3),
            "sourceDurationSeconds": round(self.source_duration_seconds, 3),
            "trimmed": self.trimmed,
            "maskedRegions": [mask.to_dict() for mask in self.masks],
        }


@dataclass(frozen=True)
class MotionMetrics:
    sample_fps: float
    frame_width: int
    frame_height: int
    per_second: tuple[float, ...]
    per_second_samples: tuple[int, ...]
    mean: float
    minimum: float
    minimum_active: float | None
    maximum: float
    first3_mean: float | None
    first4_mean: float | None
    low_motion_floor: float
    low_motion_runs: tuple[dict[str, Any], ...]
    longest_low_motion_seconds: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "sampleFps": self.sample_fps,
            "frameWidth": self.frame_width,
            "frameHeight": self.frame_height,
            "mean": round(self.mean, 3),
            "minimum": round(self.minimum, 3),
            "minimumActive": _round_optional(self.minimum_active),
            "maximum": round(self.maximum, 3),
            "first3Mean": _round_optional(self.first3_mean),
            "first4Mean": _round_optional(self.first4_mean),
            "perSecond": [round(value, 3) for value in self.per_second],
            "perSecondSamples": list(self.per_second_samples),
            "lowMotionFloor": self.low_motion_floor,
            "lowMotionRuns": list(self.low_motion_runs),
            "longestLowMotionSeconds": round(self.longest_low_motion_seconds, 3),
        }


@dataclass(frozen=True)
class CutMetrics:
    scene_threshold: float
    dedupe_seconds: float
    ignore_before_seconds: float
    times: tuple[float, ...]
    cuts_per_second: float
    longest_shot_seconds: float
    burst_window_seconds: float
    burst_step_seconds: float
    burst_windows: tuple[dict[str, Any], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "sceneThreshold": self.scene_threshold,
            "dedupeSeconds": self.dedupe_seconds,
            "ignoreBeforeSeconds": self.ignore_before_seconds,
            "times": [round(value, 3) for value in self.times],
            "count": len(self.times),
            "cutsPerSecond": round(self.cuts_per_second, 3),
            "longestShotSeconds": round(self.longest_shot_seconds, 3),
            "burstWindowSeconds": self.burst_window_seconds,
            "burstStepSeconds": self.burst_step_seconds,
            "burstWindows": list(self.burst_windows),
        }


@dataclass(frozen=True)
class SceneMetrics:
    timeline_present: bool
    composed_scene_coverage: float
    composed_scene_seconds: float
    short_shots: int
    total_shots: int
    short_shot_ratio: float
    moving_layers: int
    total_layers: int
    freeze_test_layer_motion_ratio: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "timelinePresent": self.timeline_present,
            "composedSceneCoverage": round(self.composed_scene_coverage, 3),
            "composedSceneSeconds": round(self.composed_scene_seconds, 3),
            "shortShots": self.short_shots,
            "totalShots": self.total_shots,
            "shortShotRatio": round(self.short_shot_ratio, 3),
            "movingLayers": self.moving_layers,
            "totalLayers": self.total_layers,
            "freezeTestLayerMotionRatio": round(self.freeze_test_layer_motion_ratio, 3),
        }


@dataclass(frozen=True)
class VideoMetrics:
    spec: VideoSpec
    path: Path
    sha256: str
    probe: VideoProbe
    effective: EffectiveRange
    motion: MotionMetrics
    cuts: CutMetrics

    def to_baseline_dict(self, config: MetricsConfig) -> dict[str, Any]:
        return {
            "version": BASELINE_VERSION,
            "generatedAt": _utc_now(),
            "configVersion": config.version,
            "video": {
                "id": self.spec.id,
                "role": self.spec.role,
                "path": self.spec.path,
                "sha256": self.sha256,
                "probe": self.probe.to_dict(),
                "effective": self.effective.to_dict(),
            },
            "motion": self.motion.to_dict(),
            "cuts": self.cuts.to_dict(),
        }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _round_optional(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _require_number(
    value: Any,
    label: str,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    number = float(value)
    if not np.isfinite(number):
        raise ValueError(f"{label} must be finite")
    if minimum is not None and number < minimum:
        raise ValueError(f"{label} must be >= {minimum}")
    if maximum is not None and number > maximum:
        raise ValueError(f"{label} must be <= {maximum}")
    return number


def _optional_number(
    value: Any,
    label: str,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float | None:
    if value is None:
        return None
    return _require_number(value, label, minimum, maximum)


def _probe_number(
    value: Any,
    label: str,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError as error:
            raise ValueError(f"{label} must be a number") from error
    return _require_number(value, label, minimum, maximum)


def _require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be an integer")
    if value < minimum:
        raise ValueError(f"{label} must be >= {minimum}")
    return value


def _parse_mask(value: Any, label: str) -> MaskRegion:
    region = _require_mapping(value, label)
    x = _require_number(region.get("x"), f"{label}.x", 0, 1)
    y = _require_number(region.get("y"), f"{label}.y", 0, 1)
    width = _require_number(region.get("width"), f"{label}.width", 0, 1)
    height = _require_number(region.get("height"), f"{label}.height", 0, 1)
    if width <= 0 or height <= 0:
        raise ValueError(f"{label} must have a positive width and height")
    if x + width > 1.000001 or y + height > 1.000001:
        raise ValueError(f"{label} must stay inside the frame")
    return MaskRegion(
        x=x,
        y=y,
        width=width,
        height=height,
        label=str(region.get("label", label)),
    )


def _parse_trim(value: Any, label: str) -> TrimSpec:
    if value is None:
        return TrimSpec(start_seconds=0.0, end_seconds=None)
    trim = _require_mapping(value, label)
    start = _require_number(trim.get("startSeconds", 0.0), f"{label}.startSeconds", 0)
    end = _optional_number(trim.get("endSeconds"), f"{label}.endSeconds", 0)
    if end is not None and end <= start:
        raise ValueError(f"{label}.endSeconds must be greater than startSeconds")
    return TrimSpec(start_seconds=start, end_seconds=end)


def _parse_video(value: Any, index: int) -> VideoSpec:
    label = f"videos[{index}]"
    video = _require_mapping(value, label)
    video_id = video.get("id")
    if not isinstance(video_id, str) or not video_id.strip():
        raise ValueError(f"{label}.id must be a non-empty string")
    role = video.get("role")
    if role not in {"reference", "output"}:
        raise ValueError(f"{label}.role must be 'reference' or 'output'")
    path = video.get("path")
    if not isinstance(path, str) or not path.strip():
        raise ValueError(f"{label}.path must be a non-empty string")
    masks = tuple(
        _parse_mask(region, f"{label}.maskRegions[{mask_index}]")
        for mask_index, region in enumerate(
            _require_list(video.get("maskRegions", []), f"{label}.maskRegions")
        )
    )
    return VideoSpec(
        id=video_id.strip(),
        role=role,
        path=path.strip(),
        trim=_parse_trim(video.get("trim"), f"{label}.trim"),
        mask_regions=masks,
    )


def parse_config(data: Any) -> MetricsConfig:
    root = _require_mapping(data, "config")
    version = root.get("version")
    if version != CONFIG_VERSION:
        raise ValueError(f"config.version must be {CONFIG_VERSION!r}")

    measurement = _require_mapping(root.get("measurement"), "measurement")
    sample_fps = _require_number(measurement.get("sampleFps"), "measurement.sampleFps", 0.1)
    width = _require_int(measurement.get("frameWidth"), "measurement.frameWidth", 1)
    height = _require_int(measurement.get("frameHeight"), "measurement.frameHeight", 1)
    scene_threshold = _require_number(
        measurement.get("sceneThreshold"), "measurement.sceneThreshold", 0, 1
    )
    dedupe = _require_number(measurement.get("cutDedupeSeconds"), "measurement.cutDedupeSeconds", 0)
    ignore_before = _require_number(
        measurement.get("ignoreCutsBeforeSeconds", 0.0),
        "measurement.ignoreCutsBeforeSeconds",
        0,
    )
    low_motion_floor = _require_number(
        measurement.get("lowMotionFloor"), "measurement.lowMotionFloor", 0
    )
    burst_window = _require_number(
        measurement.get("burstWindowSeconds"), "measurement.burstWindowSeconds", 0.1
    )
    burst_step = _require_number(
        measurement.get("burstStepSeconds"), "measurement.burstStepSeconds", 0.01
    )
    if burst_step > burst_window:
        raise ValueError("measurement.burstStepSeconds must be <= burstWindowSeconds")

    thresholds = _require_mapping(root.get("thresholds"), "thresholds")
    motion_range = _require_mapping(thresholds.get("editMeanMotion"), "thresholds.editMeanMotion")
    first4 = _require_mapping(thresholds.get("first4sMeanMotion"), "thresholds.first4sMeanMotion")
    first4_cuts = _require_mapping(thresholds.get("first4sHardCuts"), "thresholds.first4sHardCuts")
    burst = _require_mapping(thresholds.get("burst"), "thresholds.burst")
    static_cap = _require_mapping(
        thresholds.get("maxStaticCompositionSeconds"),
        "thresholds.maxStaticCompositionSeconds",
    )
    hold = _require_mapping(thresholds.get("hold"), "thresholds.hold")
    hold_duration = _require_mapping(hold.get("durationSeconds"), "thresholds.hold.durationSeconds")

    edit_min = _optional_number(motion_range.get("min"), "thresholds.editMeanMotion.min", 0)
    edit_max = _optional_number(motion_range.get("max"), "thresholds.editMeanMotion.max", 0)
    if edit_min is not None and edit_max is not None and edit_max < edit_min:
        raise ValueError("thresholds.editMeanMotion.max must be >= min")

    hold_min = _require_number(hold_duration.get("min"), "thresholds.hold.durationSeconds.min", 0)
    hold_max = _require_number(hold_duration.get("max"), "thresholds.hold.durationSeconds.max", 0)
    if hold_max < hold_min:
        raise ValueError("thresholds.hold.durationSeconds.max must be >= min")
    burst_start = _require_number(
        burst.get("startFraction"), "thresholds.burst.startFraction", 0, 1
    )
    burst_end = _require_number(burst.get("endFraction"), "thresholds.burst.endFraction", 0, 1)
    if burst_end <= burst_start:
        raise ValueError("thresholds.burst.endFraction must be greater than startFraction")
    hold_start = _require_number(hold.get("startFraction"), "thresholds.hold.startFraction", 0, 1)

    scene_coverage = _require_mapping(
        thresholds.get("composedSceneCoverage", {"min": 0.6}),
        "thresholds.composedSceneCoverage",
    )
    short_shots = _require_mapping(
        thresholds.get("shortShots", {"maxRatio": 0.1, "shotSeconds": 0.25}),
        "thresholds.shortShots",
    )
    freeze_test = _require_mapping(
        thresholds.get("freezeTestMotion", {"minLayerMotionRatio": 1.0}),
        "thresholds.freezeTestMotion",
    )
    composed_scene_coverage_min = _require_number(
        scene_coverage.get("min"),
        "thresholds.composedSceneCoverage.min",
        0,
        1,
    )
    short_shot_max_ratio = _require_number(
        short_shots.get("maxRatio"),
        "thresholds.shortShots.maxRatio",
        0,
        1,
    )
    short_shot_seconds = _require_number(
        short_shots.get("shotSeconds"),
        "thresholds.shortShots.shotSeconds",
        0.01,
    )
    freeze_test_min_layer_motion_ratio = _require_number(
        freeze_test.get("minLayerMotionRatio"),
        "thresholds.freezeTestMotion.minLayerMotionRatio",
        0,
        1,
    )

    timeline_value = root.get("timeline")
    timeline_config: TimelineConfig | None = None
    if timeline_value is not None:
        timeline_map = _require_mapping(timeline_value, "timeline")
        timeline_path = timeline_map.get("path")
        if timeline_path is not None and (
            not isinstance(timeline_path, str) or not timeline_path.strip()
        ):
            raise ValueError("timeline.path must be a non-empty string")
        timeline_config = TimelineConfig(
            path=None if timeline_path is None else timeline_path.strip(),
            composed_min_layers=_require_int(
                timeline_map.get("composedMinLayers", 3),
                "timeline.composedMinLayers",
                1,
            ),
        )

    videos = tuple(
        _parse_video(item, index)
        for index, item in enumerate(_require_list(root.get("videos"), "videos"))
    )
    if len({video.id for video in videos}) != len(videos):
        raise ValueError("videos[].id values must be unique")
    roles = [video.role for video in videos]
    if roles.count("reference") != 1:
        raise ValueError("config must contain exactly one video with role 'reference'")
    if roles.count("output") != 1:
        raise ValueError("config must contain exactly one video with role 'output'")

    return MetricsConfig(
        version=version,
        measurement=MeasurementConfig(
            sample_fps=sample_fps,
            frame_width=width,
            frame_height=height,
            scene_threshold=scene_threshold,
            cut_dedupe_seconds=dedupe,
            ignore_cuts_before_seconds=ignore_before,
            low_motion_floor=low_motion_floor,
            burst_window_seconds=burst_window,
            burst_step_seconds=burst_step,
        ),
        thresholds=ThresholdConfig(
            edit_mean_motion_min=edit_min,
            edit_mean_motion_max=edit_max,
            first4s_mean_motion_min=_optional_number(
                first4.get("min"),
                "thresholds.first4sMeanMotion.min",
                0,
            ),
            first4s_hard_cuts_max=(
                None
                if first4_cuts.get("max") is None
                else _require_int(first4_cuts.get("max"), "thresholds.first4sHardCuts.max", 0)
            ),
            burst_min_cuts_per_second=_require_number(
                burst.get("minCutsPerSecond"),
                "thresholds.burst.minCutsPerSecond",
                0.1,
            ),
            burst_min_duration_seconds=_require_number(
                burst.get("minDurationSeconds"),
                "thresholds.burst.minDurationSeconds",
                0.1,
            ),
            burst_start_fraction=burst_start,
            burst_end_fraction=burst_end,
            max_static_composition_seconds=_require_number(
                static_cap.get("max"),
                "thresholds.maxStaticCompositionSeconds.max",
                0,
            ),
            hold_count=_require_int(hold.get("count"), "thresholds.hold.count", 0),
            hold_min_duration_seconds=hold_min,
            hold_max_duration_seconds=hold_max,
            hold_start_fraction=hold_start,
            composed_scene_coverage_min=composed_scene_coverage_min,
            short_shot_max_ratio=short_shot_max_ratio,
            short_shot_seconds=short_shot_seconds,
            freeze_test_min_layer_motion_ratio=freeze_test_min_layer_motion_ratio,
        ),
        videos=videos,
        timeline=timeline_config,
    )


def load_config(path: str | Path) -> MetricsConfig:
    with open(path, encoding="utf-8") as handle:
        return parse_config(json.load(handle))


def _parse_timeline_layer(value: Any, index: int, scene_label: str) -> TimelineLayerSpec:
    label = f"{scene_label}.layers[{index}]"
    layer = _require_mapping(value, label)
    layer_id = layer.get("id")
    if not isinstance(layer_id, str) or not layer_id.strip():
        raise ValueError(f"{label}.id must be a non-empty string")
    role = layer.get("role")
    if not isinstance(role, str) or not role.strip():
        raise ValueError(f"{label}.role must be a non-empty string")
    start = _require_number(layer.get("startSeconds"), f"{label}.startSeconds", 0)
    end = _require_number(layer.get("endSeconds"), f"{label}.endSeconds", 0)
    if end <= start:
        raise ValueError(f"{label}.endSeconds must be greater than startSeconds")
    keyframe_count = _require_int(layer.get("keyframes", 0), f"{label}.keyframes", 0)
    moves = tuple(
        str(move)
        for move in _require_list(layer.get("moves", []), f"{label}.moves")
        if isinstance(move, str) and move.strip()
    )
    return TimelineLayerSpec(
        id=layer_id.strip(),
        role=role.strip(),
        start_seconds=start,
        end_seconds=end,
        keyframe_count=keyframe_count,
        moves=moves,
    )


def _parse_timeline_scene(value: Any, index: int) -> TimelineSceneSpec:
    label = f"timeline.scenes[{index}]"
    scene = _require_mapping(value, label)
    scene_id = scene.get("id")
    if not isinstance(scene_id, str) or not scene_id.strip():
        raise ValueError(f"{label}.id must be a non-empty string")
    start = _require_number(scene.get("startSeconds"), f"{label}.startSeconds", 0)
    end = _require_number(scene.get("endSeconds"), f"{label}.endSeconds", 0)
    if end <= start:
        raise ValueError(f"{label}.endSeconds must be greater than startSeconds")
    composed = scene.get("composed", False)
    if not isinstance(composed, bool):
        raise ValueError(f"{label}.composed must be a boolean")
    hold = scene.get("hold", False)
    if not isinstance(hold, bool):
        raise ValueError(f"{label}.hold must be a boolean")
    layers = tuple(
        _parse_timeline_layer(layer, layer_index, label)
        for layer_index, layer in enumerate(
            _require_list(scene.get("layers", []), f"{label}.layers")
        )
    )
    for layer in layers:
        if layer.start_seconds < start - 0.001 or layer.end_seconds > end + 0.001:
            raise ValueError(f"{label}.layers must stay inside the scene bounds")
    return TimelineSceneSpec(
        id=scene_id.strip(),
        start_seconds=start,
        end_seconds=end,
        composed=composed,
        hold=hold,
        layers=layers,
    )


def parse_timeline(data: Any) -> TimelineSpec:
    root = _require_mapping(data, "timeline")
    version = root.get("version")
    if version != TIMELINE_VERSION:
        raise ValueError(f"timeline.version must be {TIMELINE_VERSION!r}")
    duration = _require_number(root.get("durationSeconds"), "timeline.durationSeconds", 0.01)
    scenes = tuple(
        _parse_timeline_scene(scene, index)
        for index, scene in enumerate(_require_list(root.get("scenes"), "timeline.scenes"))
    )
    if not scenes:
        raise ValueError("timeline.scenes must not be empty")
    for scene in scenes:
        if scene.end_seconds > duration + 0.001:
            raise ValueError("timeline.scenes must stay inside durationSeconds")
    return TimelineSpec(version=version, duration_seconds=duration, scenes=scenes)


def load_timeline(path: str | Path) -> TimelineSpec:
    with open(path, encoding="utf-8") as handle:
        return parse_timeline(json.load(handle))


def _ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise RuntimeError("ffmpeg is required but was not found on PATH")
    return executable


def _ffprobe() -> str:
    executable = shutil.which("ffprobe")
    if executable is None:
        raise RuntimeError("ffprobe is required but was not found on PATH")
    return executable


def _parse_rate(value: Any) -> float:
    if not isinstance(value, str) or not value:
        return 0.0
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        try:
            divisor = float(denominator)
            return float(numerator) / divisor if divisor else 0.0
        except ValueError:
            return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def probe_video(path: Path) -> VideoProbe:
    command = [
        _ffprobe(),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path}: {result.stderr.strip()}")
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError(f"{path} has no video stream")
    container = data.get("format", {})
    try:
        duration = _probe_number(
            video.get("duration"),
            f"probe.duration[{path}]",
            0.001,
        )
    except ValueError:
        duration = _probe_number(
            container.get("duration"),
            f"probe.duration[{path}]",
            0.001,
        )
    width = _require_int(video.get("width"), f"probe.width[{path}]", 1)
    height = _require_int(video.get("height"), f"probe.height[{path}]", 1)
    fps = _parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate"))
    return VideoProbe(
        width=width,
        height=height,
        fps=fps,
        duration_seconds=duration,
        codec=str(video.get("codec_name", "unknown")),
        container=str(container.get("format_name", "unknown")),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _trim_filter(trim: TrimSpec) -> str:
    if trim.end_seconds is None:
        return f"trim=start={trim.start_seconds:g},setpts=PTS-STARTPTS"
    return f"trim=start={trim.start_seconds:g}:end={trim.end_seconds:g},setpts=PTS-STARTPTS"


def _mask_filters(masks: tuple[MaskRegion, ...]) -> list[str]:
    return [
        (
            f"drawbox=x=iw*{mask.x:g}:y=ih*{mask.y:g}:"
            f"w=iw*{mask.width:g}:h=ih*{mask.height:g}:color=black:t=fill"
        )
        for mask in masks
    ]


def build_motion_filter(
    trim: TrimSpec, masks: tuple[MaskRegion, ...], config: MeasurementConfig
) -> str:
    parts = [
        _trim_filter(trim),
        *_mask_filters(masks),
        f"fps={config.sample_fps:g}",
        f"scale={config.frame_width}:{config.frame_height}:flags=bilinear",
        "format=gray",
    ]
    return ",".join(parts)


def build_cut_filter(
    trim: TrimSpec, masks: tuple[MaskRegion, ...], config: MeasurementConfig
) -> str:
    parts = [
        _trim_filter(trim),
        *_mask_filters(masks),
        f"select='gt(scene,{config.scene_threshold:g})'",
        "showinfo",
    ]
    return ",".join(parts)


def _bucket_means(diffs: np.ndarray, sample_fps: float) -> tuple[list[float], list[int]]:
    if diffs.size == 0:
        return [], []
    centers = (np.arange(diffs.size, dtype=np.float64) + 0.5) / sample_fps
    buckets = np.floor(centers).astype(int)
    means: list[float] = []
    samples: list[int] = []
    for index in range(int(buckets[-1]) + 1):
        values = diffs[buckets == index]
        means.append(round(float(values.mean()), 3))
        samples.append(int(values.size))
    return means, samples


def _mean_before(diffs: np.ndarray, sample_fps: float, seconds: float) -> float | None:
    if diffs.size == 0:
        return None
    centers = (np.arange(diffs.size, dtype=np.float64) + 0.5) / sample_fps
    selected = diffs[centers < seconds]
    return None if selected.size == 0 else round(float(selected.mean()), 3)


def _low_motion_runs(
    per_second: list[float],
    samples: list[int],
    sample_fps: float,
    floor: float,
) -> tuple[dict[str, Any], ...]:
    runs: list[dict[str, Any]] = []
    cursor = 0.0
    start: float | None = None
    total = 0.0
    weighted = 0.0
    for value, sample_count in zip(per_second, samples, strict=True):
        duration = sample_count / sample_fps
        if value < floor:
            if start is None:
                start = cursor
            total += duration
            weighted += value * duration
        elif start is not None:
            runs.append(
                {
                    "startSeconds": round(start, 3),
                    "endSeconds": round(cursor, 3),
                    "durationSeconds": round(total, 3),
                    "meanMotion": round(weighted / total, 3) if total else 0.0,
                }
            )
            start = None
            total = 0.0
            weighted = 0.0
        cursor += duration
    if start is not None:
        runs.append(
            {
                "startSeconds": round(start, 3),
                "endSeconds": round(cursor, 3),
                "durationSeconds": round(total, 3),
                "meanMotion": round(weighted / total, 3) if total else 0.0,
            }
        )
    return tuple(runs)


def measure_motion(
    path: Path,
    trim: TrimSpec,
    masks: tuple[MaskRegion, ...],
    config: MeasurementConfig,
) -> MotionMetrics:
    command = [
        _ffmpeg(),
        "-v",
        "error",
        "-i",
        str(path),
        "-vf",
        build_motion_filter(trim, masks, config),
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg motion sampling failed for {path}: {result.stderr.decode(errors='replace')}"
        )
    frame_bytes = config.frame_width * config.frame_height
    usable = len(result.stdout) - (len(result.stdout) % frame_bytes)
    if usable <= 0:
        raise ValueError(f"ffmpeg produced no frames for {path}")
    frames = np.frombuffer(result.stdout[:usable], np.uint8).reshape(
        -1,
        config.frame_height,
        config.frame_width,
    )
    diffs = (
        np.abs(np.diff(frames.astype(np.float32), axis=0)).mean(axis=(1, 2))
        if frames.shape[0] > 1
        else np.empty(0, dtype=np.float32)
    )
    per_second, samples = _bucket_means(diffs, config.sample_fps)
    runs = _low_motion_runs(per_second, samples, config.sample_fps, config.low_motion_floor)
    active = [value for value in per_second if value >= config.low_motion_floor]
    return MotionMetrics(
        sample_fps=config.sample_fps,
        frame_width=config.frame_width,
        frame_height=config.frame_height,
        per_second=tuple(per_second),
        per_second_samples=tuple(samples),
        mean=round(float(diffs.mean()), 3) if diffs.size else 0.0,
        minimum=round(float(diffs.min()), 3) if diffs.size else 0.0,
        minimum_active=min(active) if active else None,
        maximum=round(float(diffs.max()), 3) if diffs.size else 0.0,
        first3_mean=_mean_before(diffs, config.sample_fps, 3.0),
        first4_mean=_mean_before(diffs, config.sample_fps, 4.0),
        low_motion_floor=config.low_motion_floor,
        low_motion_runs=runs,
        longest_low_motion_seconds=max((run["durationSeconds"] for run in runs), default=0.0),
    )


def dedupe_cuts(
    times: list[float], min_gap_seconds: float, ignore_before_seconds: float
) -> list[float]:
    kept: list[float] = []
    for time in sorted(times):
        if time <= ignore_before_seconds:
            continue
        if not kept or time - kept[-1] >= min_gap_seconds - 1e-9:
            kept.append(round(time, 3))
    return kept


def detect_cuts(
    path: Path,
    trim: TrimSpec,
    masks: tuple[MaskRegion, ...],
    config: MeasurementConfig,
) -> list[float]:
    command = [
        _ffmpeg(),
        "-v",
        "info",
        "-i",
        str(path),
        "-vf",
        build_cut_filter(trim, masks, config),
        "-an",
        "-f",
        "null",
        "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg cut detection failed for {path}: {result.stderr.strip()}")
    times = [
        float(match.group(1))
        for line in result.stderr.splitlines()
        if (match := TIMESTAMP_PATTERN.search(line))
    ]
    return dedupe_cuts(times, config.cut_dedupe_seconds, config.ignore_cuts_before_seconds)


def find_burst_windows(
    cuts: tuple[float, ...],
    duration: float,
    min_density: float,
    window: float,
    step: float,
) -> tuple[dict[str, Any], ...]:
    if not cuts or duration <= 0:
        return ()
    starts: list[float] = []
    cursor = 0.0
    while cursor + window <= duration + 1e-9:
        count = bisect.bisect_left(cuts, cursor + window) - bisect.bisect_left(cuts, cursor)
        if count / window >= min_density:
            starts.append(round(cursor, 3))
        cursor += step
    ranges: list[list[float]] = []
    for start in starts:
        end = start + window
        if ranges and start - ranges[-1][1] <= step + 1e-9:
            ranges[-1][1] = max(ranges[-1][1], end)
        else:
            ranges.append([start, end])
    return tuple(
        {
            "startSeconds": round(start, 3),
            "endSeconds": round(min(end, duration), 3),
            "durationSeconds": round(min(end, duration) - start, 3),
            "cutsPerSecond": round(
                (bisect.bisect_left(cuts, end) - bisect.bisect_left(cuts, start))
                / max(min(end, duration) - start, 1e-9),
                3,
            ),
        }
        for start, end in ranges
    )


def measure_video(spec: VideoSpec, root: Path, config: MetricsConfig) -> VideoMetrics:
    path = Path(spec.path) if Path(spec.path).is_absolute() else root / spec.path
    if not path.is_file():
        raise FileNotFoundError(f"video not found: {path}")
    probe = probe_video(path)
    requested_end = (
        spec.trim.end_seconds if spec.trim.end_seconds is not None else probe.duration_seconds
    )
    end = min(requested_end, probe.duration_seconds)
    start = min(spec.trim.start_seconds, probe.duration_seconds)
    if end <= start:
        raise ValueError(f"trim for {spec.id} leaves no frames")
    trim = TrimSpec(start_seconds=start, end_seconds=end)
    effective = EffectiveRange(
        start_seconds=start,
        end_seconds=end,
        duration_seconds=end - start,
        source_duration_seconds=probe.duration_seconds,
        trimmed=start > 0 or end < probe.duration_seconds - 1e-6,
        masks=spec.mask_regions,
    )
    motion = measure_motion(path, trim, spec.mask_regions, config.measurement)
    cut_times = detect_cuts(path, trim, spec.mask_regions, config.measurement)
    boundaries = [0.0, *cut_times, effective.duration_seconds]
    longest_shot = max(
        boundaries[index + 1] - boundaries[index] for index in range(len(boundaries) - 1)
    )
    cuts = CutMetrics(
        scene_threshold=config.measurement.scene_threshold,
        dedupe_seconds=config.measurement.cut_dedupe_seconds,
        ignore_before_seconds=config.measurement.ignore_cuts_before_seconds,
        times=tuple(cut_times),
        cuts_per_second=len(cut_times) / effective.duration_seconds,
        longest_shot_seconds=longest_shot,
        burst_window_seconds=config.measurement.burst_window_seconds,
        burst_step_seconds=config.measurement.burst_step_seconds,
        burst_windows=find_burst_windows(
            tuple(cut_times),
            effective.duration_seconds,
            config.thresholds.burst_min_cuts_per_second,
            config.measurement.burst_window_seconds,
            config.measurement.burst_step_seconds,
        ),
    )
    return VideoMetrics(
        spec=spec,
        path=path,
        sha256=sha256_file(path),
        probe=probe,
        effective=effective,
        motion=motion,
        cuts=cuts,
    )


def _range_threshold(minimum: float | None, maximum: float | None) -> str:
    if minimum is not None and maximum is not None:
        return f"{minimum:g}-{maximum:g}"
    if minimum is not None:
        return f">= {minimum:g}"
    if maximum is not None:
        return f"<= {maximum:g}"
    return "unbounded"


def _find_holds(metrics: VideoMetrics, thresholds: ThresholdConfig) -> tuple[dict[str, Any], ...]:
    start_at = metrics.effective.duration_seconds * thresholds.hold_start_fraction
    return tuple(
        run
        for run in metrics.motion.low_motion_runs
        if run["endSeconds"] > start_at
        and thresholds.hold_min_duration_seconds
        <= run["durationSeconds"]
        <= thresholds.hold_max_duration_seconds
    )


def _composed_scenes(
    timeline: TimelineSpec | None, min_layers: int
) -> tuple[TimelineSceneSpec, ...]:
    if timeline is None:
        return ()
    return tuple(
        scene
        for scene in timeline.scenes
        if scene.composed and len(scene.layers) >= min_layers
    )


def _union_seconds(intervals: list[tuple[float, float]]) -> float:
    if not intervals:
        return 0.0
    ordered = sorted(intervals)
    total = 0.0
    current_start, current_end = ordered[0]
    for start, end in ordered[1:]:
        if start > current_end:
            total += current_end - current_start
            current_start, current_end = start, end
        else:
            current_end = max(current_end, end)
    return total + current_end - current_start


def measure_scene_metrics(
    metrics: VideoMetrics,
    config: MetricsConfig,
    timeline: TimelineSpec | None,
) -> SceneMetrics:
    thresholds = config.thresholds
    duration = metrics.effective.duration_seconds
    min_layers = config.timeline.composed_min_layers if config.timeline else 3
    composed = _composed_scenes(timeline, min_layers)
    composed_seconds = min(
        duration,
        _union_seconds(
            [
                (max(0.0, scene.start_seconds), min(duration, scene.end_seconds))
                for scene in composed
            ]
        ),
    )
    coverage = composed_seconds / duration if duration > 0 else 0.0

    boundaries = [0.0, *metrics.cuts.times, duration]
    shots = [
        boundaries[index + 1] - boundaries[index]
        for index in range(len(boundaries) - 1)
        if boundaries[index + 1] > boundaries[index]
    ]
    short_shots = sum(
        1 for shot in shots if shot < thresholds.short_shot_seconds - 1e-9
    )
    short_ratio = short_shots / len(shots) if shots else 0.0

    freeze_scenes = [scene for scene in composed if not scene.hold]
    moving_layers = sum(
        1
        for scene in freeze_scenes
        for layer in scene.layers
        if layer.has_motion
    )
    total_layers = sum(len(scene.layers) for scene in freeze_scenes)
    freeze_ratio = moving_layers / total_layers if total_layers else 0.0

    return SceneMetrics(
        timeline_present=timeline is not None,
        composed_scene_coverage=coverage,
        composed_scene_seconds=composed_seconds,
        short_shots=short_shots,
        total_shots=len(shots),
        short_shot_ratio=short_ratio,
        moving_layers=moving_layers,
        total_layers=total_layers,
        freeze_test_layer_motion_ratio=freeze_ratio,
    )


def evaluate_scene_thresholds(
    metrics: VideoMetrics,
    config: MetricsConfig,
    timeline: TimelineSpec | None,
) -> list[dict[str, Any]]:
    thresholds = config.thresholds
    scene = measure_scene_metrics(metrics, config, timeline)
    return [
        {
            "id": "composed-scene-coverage",
            "label": "Composed scene coverage",
            "passed": bool(
                scene.composed_scene_coverage >= thresholds.composed_scene_coverage_min
            ),
            "measured": round(scene.composed_scene_coverage, 3),
            "threshold": f">= {thresholds.composed_scene_coverage_min * 100:.0f}%",
        },
        {
            "id": "short-shots",
            "label": f"Shots under {thresholds.short_shot_seconds:g}s",
            "passed": bool(scene.short_shot_ratio <= thresholds.short_shot_max_ratio),
            "measured": (
                f"{scene.short_shots}/{scene.total_shots} "
                f"({scene.short_shot_ratio * 100:.1f}%)"
            ),
            "threshold": (
                f"<= {thresholds.short_shot_max_ratio * 100:.0f}% of shots under "
                f"{thresholds.short_shot_seconds:g}s"
            ),
        },
        {
            "id": "freeze-test-motion",
            "label": "Freeze-test layer motion",
            "passed": bool(
                scene.freeze_test_layer_motion_ratio
                >= thresholds.freeze_test_min_layer_motion_ratio
            ),
            "measured": (
                f"{scene.moving_layers}/{scene.total_layers} layers "
                f"({scene.freeze_test_layer_motion_ratio * 100:.1f}%)"
            ),
            "threshold": (
                f">= {thresholds.freeze_test_min_layer_motion_ratio * 100:.0f}% "
                "of non-hold composed layers move"
            ),
        },
    ]


def evaluate_thresholds(metrics: VideoMetrics, config: MetricsConfig) -> list[dict[str, Any]]:
    thresholds = config.thresholds
    duration = metrics.effective.duration_seconds
    holds = _find_holds(metrics, thresholds)
    hold_keys = {(run["startSeconds"], run["endSeconds"]) for run in holds}
    static_outside = max(
        (
            run["durationSeconds"]
            for run in metrics.motion.low_motion_runs
            if (run["startSeconds"], run["endSeconds"]) not in hold_keys
        ),
        default=0.0,
    )
    burst_start = duration * thresholds.burst_start_fraction
    burst_end = duration * thresholds.burst_end_fraction
    qualifying_bursts = [
        window
        for window in metrics.cuts.burst_windows
        if window["startSeconds"] >= burst_start - 1e-6
        and window["endSeconds"] <= burst_end + 1e-6
        and window["durationSeconds"] >= thresholds.burst_min_duration_seconds
    ]
    first4_cuts = [time for time in metrics.cuts.times if time < 4.0]

    motion_min = thresholds.edit_mean_motion_min
    motion_max = thresholds.edit_mean_motion_max
    mean_passed = (motion_min is None or metrics.motion.mean >= motion_min) and (
        motion_max is None or metrics.motion.mean <= motion_max
    )
    first4_passed = thresholds.first4s_mean_motion_min is None or (
        metrics.motion.first4_mean is not None
        and metrics.motion.first4_mean >= thresholds.first4s_mean_motion_min
    )
    first4_cuts_passed = (
        thresholds.first4s_hard_cuts_max is None
        or len(first4_cuts) <= thresholds.first4s_hard_cuts_max
    )
    hold_durations = [run["durationSeconds"] for run in holds]
    hold_passed = len(holds) == thresholds.hold_count and all(
        thresholds.hold_min_duration_seconds
        <= duration_value
        <= thresholds.hold_max_duration_seconds
        for duration_value in hold_durations
    )

    return [
        {
            "id": "edit-mean-motion",
            "label": "Edit-only mean motion energy",
            "passed": bool(mean_passed),
            "measured": round(metrics.motion.mean, 3),
            "threshold": _range_threshold(motion_min, motion_max),
        },
        {
            "id": "first-4s-motion",
            "label": "First-4 s mean motion",
            "passed": bool(first4_passed),
            "measured": _round_optional(metrics.motion.first4_mean),
            "threshold": _range_threshold(thresholds.first4s_mean_motion_min, None),
        },
        {
            "id": "first-4s-hard-cuts",
            "label": "First-4 s hard cuts",
            "passed": bool(first4_cuts_passed),
            "measured": len(first4_cuts),
            "threshold": (
                "unbounded"
                if thresholds.first4s_hard_cuts_max is None
                else f"<= {thresholds.first4s_hard_cuts_max}"
            ),
        },
        {
            "id": "cut-burst",
            "label": "Cut burst",
            "passed": bool(qualifying_bursts),
            "measured": max(
                (window["durationSeconds"] for window in qualifying_bursts),
                default=0.0,
            ),
            "threshold": (
                f">= {thresholds.burst_min_cuts_per_second:g} cuts/s for "
                f">= {thresholds.burst_min_duration_seconds:g}s within "
                f"{thresholds.burst_start_fraction * 100:.0f}-"
                f"{thresholds.burst_end_fraction * 100:.0f}%"
            ),
        },
        {
            "id": "static-outside-hold",
            "label": "Longest static composition outside the hold",
            "passed": bool(static_outside <= thresholds.max_static_composition_seconds),
            "measured": round(static_outside, 3),
            "threshold": f"<= {thresholds.max_static_composition_seconds:g}s",
        },
        {
            "id": "hold",
            "label": "Deliberate hold",
            "passed": bool(hold_passed),
            "measured": hold_durations,
            "threshold": (
                f"exactly {thresholds.hold_count} hold(s) of "
                f"{thresholds.hold_min_duration_seconds:g}-"
                f"{thresholds.hold_max_duration_seconds:g}s after "
                f"{thresholds.hold_start_fraction * 100:.0f}%"
            ),
        },
    ]


def _format_pair(probe: VideoProbe) -> str:
    return f"{probe.width}x{probe.height}@{probe.fps:g}fps"


def _comparison_rows(reference: VideoMetrics, output: VideoMetrics) -> list[dict[str, Any]]:
    return [
        {
            "metric": "Format",
            "reference": _format_pair(reference.probe),
            "output": _format_pair(output.probe),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Effective duration (s)",
            "reference": round(reference.effective.duration_seconds, 3),
            "output": round(output.effective.duration_seconds, 3),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Mean motion energy",
            "reference": round(reference.motion.mean, 3),
            "output": round(output.motion.mean, 3),
            "threshold": "see edit-mean-motion",
            "passed": None,
        },
        {
            "metric": "Lowest per-second motion",
            "reference": round(reference.motion.minimum, 3),
            "output": round(output.motion.minimum, 3),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Lowest active per-second motion",
            "reference": _round_optional(reference.motion.minimum_active),
            "output": _round_optional(output.motion.minimum_active),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "First-3 s mean motion",
            "reference": _round_optional(reference.motion.first3_mean),
            "output": _round_optional(output.motion.first3_mean),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Hard cuts",
            "reference": len(reference.cuts.times),
            "output": len(output.cuts.times),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Cut density (cuts/s)",
            "reference": round(reference.cuts.cuts_per_second, 3),
            "output": round(output.cuts.cuts_per_second, 3),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Longest unbroken shot (s)",
            "reference": round(reference.cuts.longest_shot_seconds, 3),
            "output": round(output.cuts.longest_shot_seconds, 3),
            "threshold": None,
            "passed": None,
        },
        {
            "metric": "Burst windows",
            "reference": [window["durationSeconds"] for window in reference.cuts.burst_windows],
            "output": [window["durationSeconds"] for window in output.cuts.burst_windows],
            "threshold": "see cut-burst",
            "passed": None,
        },
        {
            "metric": "Longest static composition (s)",
            "reference": round(reference.motion.longest_low_motion_seconds, 3),
            "output": round(output.motion.longest_low_motion_seconds, 3),
            "threshold": "see static-outside-hold",
            "passed": None,
        },
    ]


def _scene_comparison_rows(
    reference: VideoMetrics,
    output: VideoMetrics,
    config: MetricsConfig,
    output_scene: SceneMetrics,
) -> list[dict[str, Any]]:
    reference_scene = measure_scene_metrics(reference, config, None)
    short_seconds = config.thresholds.short_shot_seconds
    return [
        {
            "metric": "Composed scene coverage",
            "reference": "n/a",
            "output": (
                f"{output_scene.composed_scene_coverage * 100:.1f}% "
                f"({output_scene.composed_scene_seconds:g}s)"
            ),
            "threshold": "see composed-scene-coverage",
            "passed": None,
        },
        {
            "metric": f"Shots under {short_seconds:g}s",
            "reference": (
                f"{reference_scene.short_shots}/{reference_scene.total_shots} "
                f"({reference_scene.short_shot_ratio * 100:.1f}%)"
            ),
            "output": (
                f"{output_scene.short_shots}/{output_scene.total_shots} "
                f"({output_scene.short_shot_ratio * 100:.1f}%)"
            ),
            "threshold": "see short-shots",
            "passed": None,
        },
        {
            "metric": "Freeze-test layer motion",
            "reference": "n/a",
            "output": (
                f"{output_scene.moving_layers}/{output_scene.total_layers} layers "
                f"({output_scene.freeze_test_layer_motion_ratio * 100:.1f}%)"
            ),
            "threshold": "see freeze-test-motion",
            "passed": None,
        },
    ]


def build_comparison(
    reference: VideoMetrics,
    output: VideoMetrics,
    config: MetricsConfig,
    timeline: TimelineSpec | None = None,
) -> dict[str, Any]:
    findings = evaluate_thresholds(output, config) + evaluate_scene_thresholds(
        output, config, timeline
    )
    reference_findings = evaluate_thresholds(reference, config)
    output_scene = measure_scene_metrics(output, config, timeline)
    passed = sum(1 for finding in findings if finding["passed"])
    return {
        "version": COMPARISON_VERSION,
        "generatedAt": _utc_now(),
        "configVersion": config.version,
        "reference": {
            "id": reference.spec.id,
            "path": reference.spec.path,
            "sha256": reference.sha256,
        },
        "output": {
            "id": output.spec.id,
            "path": output.spec.path,
            "sha256": output.sha256,
        },
        "rows": _comparison_rows(reference, output)
        + _scene_comparison_rows(reference, output, config, output_scene),
        "sceneMetrics": output_scene.to_dict(),
        "referenceThresholds": reference_findings,
        "thresholds": findings,
        "summary": {
            "passed": passed,
            "failed": len(findings) - passed,
            "allPassed": passed == len(findings),
        },
    }


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _print_table(
    reference: VideoMetrics,
    output: VideoMetrics,
    findings: list[dict[str, Any]],
    rows: list[dict[str, Any]] | None = None,
) -> None:
    print(f"{'metric':<38} {'reference':<22} {'output':<22} status")
    print(f"{'-' * 38} {'-' * 22} {'-' * 22} {'-' * 6}")
    for row in rows if rows is not None else _comparison_rows(reference, output):
        if row["passed"] is None:
            status = ""
        else:
            status = "PASS" if row["passed"] else "FAIL"
        print(f"{row['metric']:<38} {str(row['reference']):<22} {str(row['output']):<22} {status}")
    print()
    for finding in findings:
        status = "PASS" if finding["passed"] else "FAIL"
        print(
            f"{status}  {finding['label']}: measured {finding['measured']} "
            f"(threshold {finding['threshold']})"
        )


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "video"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="kove-mograph-metrics",
        description="Measure motion energy and cut cadence for a reference/output video pair.",
    )
    parser.add_argument(
        "--config",
        default="evaluation-files/mograph-baseline/config.json",
        help="Path to the metrics config JSON",
    )
    parser.add_argument("--out", help="Directory for baseline JSON (default: config directory)")
    parser.add_argument("--root", default=".", help="Base directory for relative video paths")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit nonzero when the output fails a configured threshold",
    )
    args = parser.parse_args(argv)

    config_path = Path(args.config)
    config = load_config(config_path)
    root = Path(args.root).resolve()
    out_dir = Path(args.out) if args.out else config_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    measured: dict[str, VideoMetrics] = {}
    for spec in config.videos:
        metrics = measure_video(spec, root, config)
        measured[spec.role] = metrics
        _write_json(out_dir / f"{_safe_name(spec.id)}.json", metrics.to_baseline_dict(config))
        print(f"wrote {out_dir / f'{_safe_name(spec.id)}.json'}")

    timeline = None
    if config.timeline is not None and config.timeline.path is not None:
        timeline = load_timeline(root / config.timeline.path)
        print(f"loaded timeline {root / config.timeline.path}")

    reference = measured["reference"]
    output = measured["output"]
    comparison = build_comparison(reference, output, config, timeline)
    _write_json(out_dir / "comparison.json", comparison)
    print(f"wrote {out_dir / 'comparison.json'}")
    print()
    _print_table(reference, output, comparison["thresholds"], comparison["rows"])
    reference_findings = comparison["referenceThresholds"]
    reference_passed = sum(1 for finding in reference_findings if finding["passed"])
    print(f"\nReference self-check: {reference_passed}/{len(reference_findings)} thresholds passed")
    if args.check and not comparison["summary"]["allPassed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
