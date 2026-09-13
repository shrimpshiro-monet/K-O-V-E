from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from statistics import mean, median
from typing import Any

from kove_engine.types import AudioResult, FrameDescription, VideoSegmentMap


ANALYSIS_VERSION = "1.1.0"
STYLE_PROFILE_VERSION = "1.0.0"


@dataclass(frozen=True)
class ReferenceAnalysisOptions:
    fast_cut_seconds: float = 1.5
    slow_cut_seconds: float = 6.0


def _round(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def _style_profile(
    video: VideoSegmentMap,
    observations: list[dict[str, Any]],
    audio: list[AudioResult],
    pacing: str,
    forensics: dict[str, Any] | None,
) -> dict[str, Any]:
    durations = [item["duration"] for item in observations if item["duration"] > 0]
    cut_count = max(0, len(video.segments) - 1)
    shot_types = Counter(item["sceneType"] for item in observations)
    effect_candidates = (forensics or {}).get("effectCandidates", [])
    overlay_candidates = (forensics or {}).get("overlayCandidates", [])
    transition_candidates = (forensics or {}).get("transitions", [])
    bpm_values = [result.bpm for result in audio if result.bpm]

    cut_on_beat_ratio: float | None = None
    if bpm_values and video.segments[1:]:
        beat_period = 60.0 / (sum(bpm_values) / len(bpm_values))
        aligned = sum(
            min((boundary.start_time % beat_period), beat_period - (boundary.start_time % beat_period)) <= 0.15
            for boundary in video.segments[1:]
        )
        cut_on_beat_ratio = aligned / len(video.segments[1:])

    return {
        "version": STYLE_PROFILE_VERSION,
        "pacing": pacing,
        "cutsPerMinute": _round(cut_count / (video.duration / 60)) if video.duration > 0 else 0.0,
        "medianShotDuration": _round(median(durations)) if durations else 0.0,
        "cutOnBeatRatio": _round(cut_on_beat_ratio) if cut_on_beat_ratio is not None else None,
        "effectDensity": _round(len(effect_candidates) / (video.duration / 60)) if video.duration > 0 else 0.0,
        "transitionDensity": _round(len(transition_candidates) / (video.duration / 60)) if video.duration > 0 else 0.0,
        "textOverlayDensity": _round(len(overlay_candidates) / (video.duration / 60)) if video.duration > 0 else 0.0,
        "shotTypeDistribution": {
            name: _round(count / max(1, len(observations)))
            for name, count in shot_types.items()
        },
        "cutStyle": "mixed" if transition_candidates else "hard" if cut_count else "unknown",
        "effectPalette": sorted({candidate.get("type", "") for candidate in effect_candidates if candidate.get("type")}),
        "transitionPalette": sorted({candidate.get("type", "") for candidate in transition_candidates if candidate.get("type")}),
        "detectedBpm": _round(sum(bpm_values) / len(bpm_values), 1) if bpm_values else None,
        "dialogueRatio": _round(mean(1.0 if item["hasDialogue"] else 0.0 for item in observations)) if observations else 0.0,
        "musicRatio": _round(mean(1.0 if result.has_music else 0.0 for result in audio)) if audio else 0.0,
        "confidence": _round(mean(item["confidence"] for item in observations)) if observations else 0.0,
    }


def analyze_reference_edit(
    video: VideoSegmentMap,
    frames: list[FrameDescription],
    audio: list[AudioResult],
    options: ReferenceAnalysisOptions | None = None,
    forensics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build edit-forensics evidence from sampled observations.

    This describes evidence rather than claiming to recover the original NLE project.
    AI vision can enrich the same report later.
    """
    config = options or ReferenceAnalysisOptions()
    ordered_frames = sorted(frames, key=lambda frame: frame.timestamp)
    observations = []
    for index, frame in enumerate(ordered_frames):
        next_timestamp = (
            ordered_frames[index + 1].timestamp
            if index + 1 < len(ordered_frames)
            else video.duration
        )
        observations.append({
            "timestamp": _round(frame.timestamp),
            "endTimestamp": _round(max(frame.timestamp, next_timestamp)),
            "duration": _round(max(0.0, next_timestamp - frame.timestamp)),
            "sceneType": frame.scene_type.value,
            "motionLevel": frame.motion_level.value,
            "hasDialogue": frame.has_dialogue,
            "description": frame.description,
            "confidence": _round(frame.confidence),
        })

    durations = [item["duration"] for item in observations if item["duration"] > 0]
    scene_types = Counter(item["sceneType"] for item in observations)
    motion_levels = Counter(item["motionLevel"] for item in observations)
    dialogue_ratio = (
        mean(1.0 if item["hasDialogue"] else 0.0 for item in observations)
        if observations else 0.0
    )
    cut_count = max(0, len(video.segments) - 1)
    pacing = "unknown"
    if durations:
        typical_duration = median(durations)
        pacing = (
            "fast" if typical_duration <= config.fast_cut_seconds
            else "slow" if typical_duration >= config.slow_cut_seconds
            else "moderate"
        )

    cues: list[dict[str, Any]] = []
    for item in observations:
        uses: list[str] = []
        if item["hasDialogue"]:
            uses.append("dialogue-led storytelling")
        if item["sceneType"] == "b-roll":
            uses.append("b-roll coverage")
        if item["sceneType"] == "transition":
            uses.append("transition or bridge")
        if item["motionLevel"] in {"high", "medium"}:
            uses.append("energy emphasis")
        if item["duration"] <= config.fast_cut_seconds:
            uses.append("quick pacing")
        if uses:
            cues.append({
                "startTime": item["timestamp"],
                "endTime": item["endTimestamp"],
                "usedFor": uses,
                "evidence": item["description"],
                "confidence": item["confidence"],
            })

    report = {
        "analysisVersion": ANALYSIS_VERSION,
        "videoId": video.video_id,
        "duration": _round(video.duration),
        "summary": {
            "pacing": pacing,
            "cutCount": cut_count,
            "cutsPerMinute": _round(cut_count / (video.duration / 60)) if video.duration > 0 else 0.0,
            "dominantSceneTypes": [name for name, _ in scene_types.most_common()],
            "dominantMotionLevels": [name for name, _ in motion_levels.most_common()],
            "dialogueLed": dialogue_ratio >= 0.35,
        },
        "styleProfile": _style_profile(video, observations, audio, pacing, forensics),
        "editPattern": {
            "cutStyle": "rapid montage" if pacing == "fast" else "coverage-led",
            "transitionEvidence": [{
                "type": "hard-cut",
                "count": cut_count,
                "confidence": 0.55 if cut_count else 0.0,
                "note": "Fallback estimate from classified segment boundaries.",
            }],
            "effects": [],
            "textOverlays": [],
            "colorTreatment": {
                "status": "requires_visual_vision",
                "evidence": "Local pass records scene and motion evidence; AI vision may identify grading and overlays.",
            },
        },
        "audio": {
            "dialogueRatio": _round(dialogue_ratio),
            "musicRatio": _round(mean(1.0 if result.has_music else 0.0 for result in audio)) if audio else 0.0,
            "silenceRatio": _round(mean(1.0 if result.is_silence else 0.0 for result in audio)) if audio else 0.0,
            "detectedBpm": _round(mean([result.bpm for result in audio if result.bpm]), 1)
            if any(result.bpm for result in audio) else None,
        },
        "timeline": cues,
        "observations": observations,
    }
    if forensics:
        report["forensics"] = forensics
        transitions = forensics.get("transitions", [])
        report["editPattern"]["transitionEvidence"] = transitions or report["editPattern"]["transitionEvidence"]
        report["editPattern"]["textOverlays"] = forensics.get("overlayCandidates", [])
        report["editPattern"]["effects"] = forensics.get("effectCandidates", [])
        report["editPattern"]["colorTreatment"] = forensics.get("visualTreatment", {})
    return report