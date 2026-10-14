"""Reference -> plan -> (production snap) -> render.

The planner here is deliberately *neutral*: it takes the reference's measured
style and applies each dimension in the most obvious way. That is what makes the
baseline a baseline — the gap it shows is the gap the product has, not a gap
created by leaving a feature switched off on purpose. Each numbered step in the
plan then replaces one dimension with a measured one and the scorecard shows the
delta.

The LLM director is not in this path. It needs an API key this environment does
not have, and its output is an `EditPlan` — which is exactly the interface this
pipeline takes. When the director is wired in, it substitutes for
`plan_from_style` and the rest of the measurement is unchanged.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import bridge, metrics, repo
from .compositor import Clip, Grade, Timeline
from .media import probe

CRAFT_VERSION = "0.1.0"
PLAN_VERSION = "craft-1"


@dataclass
class MeasuredStyle:
    """What the reference measures as. Written to disk and printed in reports."""

    reference_id: str
    duration: float
    size: list[int]
    fps: float
    cuts: list[float]
    shot_lengths: list[float]
    shot_lengths_beats: list[float]
    bpm: float | None
    beats: list[float]
    beat_source: str
    beat_offset_seconds: float
    on_beat_ratio: float | None
    motion_events: list[dict]
    transition_mix: dict
    grades: dict
    caption_windows: list[list[float]]
    loudness: dict
    duck_db: float | None

    def as_dict(self) -> dict:
        return self.__dict__.copy()

    @property
    def median_shot_beats(self) -> float:
        if not self.shot_lengths_beats:
            return 4.0
        return float(np.median(self.shot_lengths_beats))


logger = logging.getLogger(__name__)


def _cache_path(cache_dir: Path, kind: str, path: str, extra: str = "") -> Path:
    """Cache key: kind + path + mtime, so editing a fixture invalidates it."""
    stat = Path(path).stat().st_mtime_ns if Path(path).exists() else 0
    digest = hashlib.sha256(f"{kind}:{path}:{extra}:{stat}".encode()).hexdigest()[:16]
    return cache_dir / f"{kind}-{Path(path).stem}-{digest}.json"


def analyze_reference(
    reference_path: Path,
    *,
    cache_dir: Path | None = None,
    force: bool = False,
) -> MeasuredStyle:
    """Measure a reference with the engine's analyzers plus the craft signals."""
    repo.ensure_engine_importable()
    repo.ensure_tools_on_path()
    from kove_engine.beat_grid import extract_audio_track, track_beat_grid

    cache_dir = cache_dir or reference_path.parent / ".cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = _cache_path(cache_dir, "refstyle", str(reference_path))
    if cache_file.exists() and not force:
        return MeasuredStyle(**json.loads(cache_file.read_text()))

    info = probe(reference_path)
    boundaries = metrics.shot_boundaries(reference_path, info.duration)
    cuts = metrics.cut_times(boundaries)
    lengths = [duration for _start, duration in boundaries]

    # Beats come from the PRODUCT's detector, through the bridge.
    #
    # The engine's librosa tracker reads 179-264 ms out of phase with a known
    # pulse and puts 0.000 of its beats on the true kick, while the product's own
    # `BeatDetectionEngine` is within 10 ms (both measured; see F11/F12 in the
    # craft log). Snapping a plan to the librosa grid therefore reproduced a
    # 200 ms phase error that the product does not have, and the scorecard charged
    # it to the edit. Measuring the wrong grid is not measuring the edit.
    beats: list[float] = []
    if wav := metrics.audio_wav(reference_path):
        try:
            detected = bridge.call({"op": "detect-beats", "wav": str(wav)})
            beats = [float(beat) for beat in detected.get("beats", [])]
        except Exception as exc:  # bridge unavailable: fall back, but say so
            logger.warning("product beat detector unavailable (%s); using the engine", exc)
        finally:
            wav.unlink(missing_ok=True)

    beat_source = "product-detector"
    if not beats:
        beat_source = "engine-librosa"
        samples = extract_audio_track(str(reference_path))
        grid = track_beat_grid(samples) if samples is not None else None
        beats = list(grid.beats) if grid and grid.has_grid else []

    # The tempo scalar is derived from the beats rather than taken from the
    # tracker's own estimate: librosa reports 144.23 BPM for a track whose beat
    # positions average 139.994 (the median interval is biased by hop
    # quantisation), and the two disagreeing is a trap for anything downstream.
    bpm = 60.0 / ((beats[-1] - beats[0]) / (len(beats) - 1)) if len(beats) >= 2 else None

    alignment = metrics.beat_alignment(cuts, beats) if beats else None

    # Motion events read from a sample of the file: every shot's first second plus
    # its last, which is where push-ins and punch-ins actually happen.
    motion_events: list[dict] = []
    for start, span in boundaries:
        if span < 0.5:
            continue
        trace = metrics.affine_trace(reference_path, start=start, end=min(span, 2.2))
        for event in metrics.detect_motion_events(trace):
            motion_events.append(
                {
                    "time": round(start + event.time, 3),
                    "kind": event.kind,
                    "magnitude": round(event.magnitude, 4),
                }
            )

    transition_mix = metrics.classify_transitions(reference_path, boundaries).as_dict()
    grades = metrics.color_stats(reference_path, boundaries)
    captions = metrics.caption_windows(reference_path)
    loudness = metrics.integrated_loudness(reference_path).as_dict()

    speech_windows: list[tuple[float, float]] = []
    ground_truth = reference_path.with_suffix(".groundtruth.json")
    if ground_truth.exists():
        payload = json.loads(ground_truth.read_text())
        speech_windows = [tuple(pair) for pair in payload.get("speech_windows", [])]
    duck = metrics.ducking_depth_db(reference_path, speech_windows) if speech_windows else None

    style = MeasuredStyle(
        reference_id=reference_path.stem,
        duration=info.duration,
        size=[info.width, info.height],
        fps=info.fps,
        cuts=cuts,
        shot_lengths=[round(length, 4) for length in lengths],
        shot_lengths_beats=(
            [round(length / (60.0 / bpm), 4) for length in lengths] if bpm else []
        ),
        bpm=bpm,
        beats=[round(beat, 4) for beat in beats],
        beat_source=beat_source,
        beat_offset_seconds=round(alignment.median_offset_ms / 1000.0, 4)
        if alignment and alignment.median_offset_ms is not None
        else 0.0,
        on_beat_ratio=alignment.on_beat_ratio if alignment else None,
        motion_events=motion_events,
        transition_mix=transition_mix,
        grades=grades,
        caption_windows=[list(window) for window in captions.windows],
        loudness=loudness,
        duck_db=duck,
    )
    cache_file.write_text(json.dumps(style.as_dict(), indent=2))
    return style


@dataclass
class PlannedOutput:
    """A rendered attempt at a reference."""

    reference_id: str
    output_path: Path
    plan: dict
    snap_report: dict
    style: MeasuredStyle
    timeline: Timeline = field(repr=False, default=None)  # type: ignore[assignment]
    notes: list[str] = field(default_factory=list)


def feed_for_style(style: MeasuredStyle) -> tuple[Timeline, dict]:
    """The naive baseline: match cut *rate*, identity grade, no motion, no audio
    work beyond playing the bed.

    Each of those four omissions is a numbered step in the plan. Leaving them out
    here is what makes the later deltas attributable.
    """
    from .build import _golden_media_paths  # local import: avoids a cycle

    packs, track, voice = _golden_media_paths()
    beat_period = 60.0 / style.bpm if style.bpm else 1.0
    median_beats = style.median_shot_beats or 4.0

    # Shot lengths follow the reference's measured distribution, rounded to whole
    # beats — the coarsest, most obvious reading of "match the rhythm".
    lengths_beats = [
        max(1.0, round(value)) for value in style.shot_lengths_beats
    ] or [median_beats]
    if not lengths_beats:
        lengths_beats = [4.0]

    duration = style.duration
    pack_ids = sorted(packs)
    clips: list[Clip] = []
    cursor = 0.0
    index = 0
    while cursor < duration - 1e-3 and index < 512:
        beats = lengths_beats[index % len(lengths_beats)]
        shot = beats * beat_period
        shot = min(shot, duration - cursor)
        if shot <= 1e-3:
            break
        pack_id = pack_ids[index % len(pack_ids)]
        pack_path = packs[pack_id]
        source_start = (index * 1.7) % 6.0
        clips.append(
            Clip(
                source=pack_path,
                source_start=source_start,
                source_end=source_start + shot,
                timeline_start=cursor,
                pack_id=pack_id,
                grade=Grade(),
                moves=[],
                captions=[],
                transition_in="cut",
                label=f"{pack_id}#{index}",
            )
        )
        cursor += shot
        index += 1

    timeline = Timeline(
        clips=clips,
        fps=25.0,
        size=(style.size[0], style.size[1]),
        music=str(track),
        music_gain=0.9,
        voice=str(voice) if voice else "",
        voice_gain=0.4 if voice else 0.0,
        speech_windows=[],
        duck_db=0.0,
    )
    return timeline, _plan_document(clips, track, style)


def _plan_document(clips: list[Clip], track: Path, style: MeasuredStyle) -> dict:
    """The `EditPlan` the production snapper consumes.

    Shaped like the real thing rather than like a simplified fixture: the music
    bed is an `audioDecision` with a source id, because that is how
    `resolveTimelineBeatGrid` decides between the bed's grid and the footage's.
    """
    segments = [
        {
            "sourceVideoId": clip.pack_id,
            "sourceStartTime": round(clip.source_start, 6),
            "sourceEndTime": round(clip.source_end, 6),
            "effects": [],
            "rationale": f"shot {index} at {round(clip.duration, 3)}s",
        }
        for index, clip in enumerate(clips)
    ]
    return {
        "planVersion": PLAN_VERSION,
        "segments": segments,
        "textElements": [],
        "effects": [],
        "transitions": [],
        "audioDecisions": [
            {
                "type": "music",
                "sourceVideoId": f"music:{track.stem}",
                "sourceStartTime": 0.0,
                "sourceEndTime": round(style.duration, 6),
                "startTime": 0.0,
                "duration": round(style.duration, 6),
                "volume": 0.9,
                "rationale": "reference track as the bed",
            }
        ],
        "metadata": {
            "targetDuration": round(style.duration, 6),
            "targetPlatform": "craft-eval",
            "genre": style.reference_id,
            "pacing": "medium",
            "rationale": PLAN_VERSION,
        },
    }


def segment_map_for(style: MeasuredStyle, track: Path, pack_ids: list[str]) -> dict:
    """Beats per source, in the shape `sourceBeatsByVideo` reads."""
    from .build import _golden_media_paths

    packs, _track, _voice = _golden_media_paths()
    videos = []
    for pack_id in pack_ids:
        videos.append(
            {
                "videoId": pack_id,
                "duration": 40.0,
                "segments": [
                    {
                        "id": f"{pack_id}-0",
                        "startTime": 0.0,
                        "endTime": 40.0,
                        "beatTimestamps": [],
                    }
                ],
            }
        )
    videos.append(
        {
            "videoId": f"music:{track.stem}",
            "duration": round(style.duration, 4),
            "segments": [
                {
                    "id": f"music:{track.stem}-0",
                    "startTime": 0.0,
                    "endTime": round(style.duration, 4),
                    "beatTimestamps": style.beats,
                }
            ],
        }
    )
    return {"videos": videos}


def build_output(
    reference_path: Path,
    out_path: Path,
    *,
    cache_dir: Path | None = None,
    force_analysis: bool = False,
    apply_snap: bool = True,
    frame_align: bool = True,
) -> PlannedOutput:
    """Reference + raw footage -> a rendered attempt."""
    from .build import _golden_media_paths

    style = analyze_reference(reference_path, cache_dir=cache_dir, force=force_analysis)
    timeline, plan = feed_for_style(style)
    packs, track, _voice = _golden_media_paths()

    notes: list[str] = []
    snap_report: dict = {}
    if apply_snap and style.beats:
        segment_map = segment_map_for(style, track, sorted(packs))
        result = bridge.snap_plan(
            plan,
            segment_map,
            cut_offset_seconds=style.beat_offset_seconds,
            reference_shot_lengths_in_beats=style.shot_lengths_beats or None,
            # The rate this timeline will actually render at, so the snapper can
            # put the cuts on the frames the file will have. `frame_align=False`
            # is the A/B control: the same plan, left for the renderer to round.
            fps=timeline.fps if frame_align else None,
        )
        snap_report = result["report"]
        plan = result["plan"]
        timeline = _apply_snapped_positions(timeline, plan)
        frame_note = (
            f", frames={snap_report['frameAlignedCuts']} cuts at {snap_report['fps']}fps "
            f"(max {snap_report['maxAbsFrameShiftSeconds'] * 1000:.1f}ms)"
            if snap_report.get("fps")
            else ""
        )
        notes.append(
            f"production beat snap moved {snap_report['snappedCuts']}/"
            f"{snap_report['totalCuts']} cuts (grid={snap_report['gridSource']}, "
            f"step={snap_report['gridStepSeconds']:.3f}s{frame_note})"
        )
    elif apply_snap:
        notes.append("no beat grid measured on the reference track; cuts left where planned")

    from .compositor import render_timeline

    render_timeline(timeline, out_path)
    return PlannedOutput(
        reference_id=style.reference_id,
        output_path=out_path,
        plan=plan,
        snap_report=snap_report,
        style=style,
        timeline=timeline,
        notes=notes,
    )


def plan_cut_times(plan: dict) -> list[float]:
    """The cut times a plan asks for: the end of each shot, in timeline seconds.

    This is what `_apply_snapped_positions` places the render's clips at, so it is
    the right-hand side of every render-timing comparison. It is a running sum of
    the snapped durations — the same arithmetic the renderer receives, rather than
    a re-derivation that could disagree with it.
    """
    cursor = 0.0
    cuts: list[float] = []
    segments = plan.get("segments") or []
    for segment in segments:
        duration = float(segment["sourceEndTime"]) - float(segment["sourceStartTime"])
        cursor = round(cursor + duration, 6)
        cuts.append(cursor)
    # The last entry is the end of the timeline, not a cut.
    return cuts[:-1]


def _apply_snapped_positions(timeline: Timeline, plan: dict) -> Timeline:
    """Move the render's clips to the positions the snapper chose.

    The snapper rewrites `sourceStartTime`/`sourceEndTime` and the placement comes
    from `computePlanPlacement`; here that is a running sum, which is what the
    compilers do too. Reading the snapped spans back is what makes the render
    reflect the snapped plan rather than the pre-snap one.
    """
    cursor = 0.0
    for clip, segment in zip(timeline.clips, plan["segments"], strict=False):
        clip.timeline_start = round(cursor, 6)
        clip.source_start = segment["sourceStartTime"]
        clip.source_end = segment["sourceEndTime"]
        cursor += clip.duration
    return timeline
