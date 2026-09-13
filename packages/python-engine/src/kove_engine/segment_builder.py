from __future__ import annotations

from collections import Counter

from kove_engine.types import (
    FrameDescription,
    VideoSegment,
    VideoSegmentMap,
)


class SegmentBuilder:
    def __init__(self, time_gap_threshold: float = 5.0) -> None:
        self.time_gap_threshold = time_gap_threshold

    def build(
        self, frames: list[FrameDescription], video_id: str, duration: float
    ) -> VideoSegmentMap:
        """Group consecutive frames into VideoSegments."""
        if not frames:
            return VideoSegmentMap(video_id=video_id, duration=duration, segments=[])

        groups: list[list[FrameDescription]] = []
        current_group = [frames[0]]

        for prev, curr in zip(frames, frames[1:]):
            if self._should_split(prev, curr):
                groups.append(current_group)
                current_group = [curr]
            else:
                current_group.append(curr)

        groups.append(current_group)

        segments = [self._group_to_segment(video_id, i, group) for i, group in enumerate(groups)]

        return VideoSegmentMap(video_id=video_id, duration=duration, segments=segments)

    def _should_split(self, prev: FrameDescription, curr: FrameDescription) -> bool:
        if prev.scene_type != curr.scene_type:
            return True
        if prev.motion_level != curr.motion_level:
            return True
        if curr.timestamp - prev.timestamp > self.time_gap_threshold:
            return True
        return False

    def _group_to_segment(
        self, video_id: str, index: int, group: list[FrameDescription]
    ) -> VideoSegment:
        descriptions = [f.description for f in group]
        scene_types = [f.scene_type for f in group]
        motion_levels = [f.motion_level for f in group]
        motion_scores = [f.motion_score for f in group]
        audio_energies = [f.audio_rms_energy for f in group]
        bpm_values = [f.audio_bpm for f in group if f.audio_bpm is not None]
        face_frames = sum(1 for f in group if f.face_count > 0)
        face_presence_ratio = face_frames / len(group)
        motion_peak = max(motion_scores, default=0.0)
        audio_energy = sum(audio_energies) / len(audio_energies)
        beat_timestamps = [f.timestamp for f in group if f.audio_bpm is not None and f.has_music]
        importance_score = min(
            1.0,
            0.5 * motion_peak
            + 0.3 * audio_energy
            + 0.1 * face_presence_ratio
            + 0.1 * (1.0 if any(f.shot_boundary for f in group) else 0.0),
        )
        sports_moment_score = min(
            1.0,
            0.5 * motion_peak
            + 0.25 * audio_energy
            + 0.1 * face_presence_ratio
            + 0.1 * (1.0 if any(f.shot_boundary for f in group) else 0.0)
            + 0.05 * (1.0 if any(f.has_dialogue for f in group) else 0.0),
        )
        sports_moment_event = (
            "dialogue-emphasis" if any(f.has_talking_head or f.has_dialogue for f in group)
            else "crowd-reaction" if audio_energy >= 0.75 and motion_peak >= 0.65
            else "shot-release" if motion_peak >= 0.8
            else "action-peak" if motion_peak >= 0.55
            else "unknown"
        )
        subject_ids = [f"face-{index}" for index in range(max((f.face_count for f in group), default=0))]
        subject_continuity_score = face_presence_ratio if subject_ids else 0.0

        return VideoSegment(
            id=f"{video_id}-seg-{index}",
            start_time=group[0].timestamp,
            end_time=group[-1].timestamp,
            description=" | ".join(descriptions),
            scene_type=Counter(scene_types).most_common(1)[0][0],
            motion_level=Counter(motion_levels).most_common(1)[0][0],
            has_dialogue=any(f.has_dialogue for f in group),
            visual_content=" | ".join(descriptions),
            confidence=sum(f.confidence for f in group) / len(group),
            motion_peak=motion_peak,
            audio_energy=audio_energy,
            audio_bpm=sum(bpm_values) / len(bpm_values) if bpm_values else None,
            beat_timestamps=beat_timestamps,
            face_presence_ratio=face_presence_ratio,
            has_talking_head=any(f.has_talking_head for f in group),
            shot_boundary_at_start=group[0].shot_boundary,
            importance_score=importance_score,
            sports_moment_score=sports_moment_score,
            sports_moment_event=sports_moment_event,
            subject_ids=subject_ids,
            subject_continuity_score=subject_continuity_score,
        )
