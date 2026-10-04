from __future__ import annotations

import logging
import subprocess
from collections.abc import Callable
from pathlib import Path

from kove_engine.analyzers.audio_analyzer import AudioAnalyzer
from kove_engine.analyzers.face_analyzer import FaceAnalyzer
from kove_engine.analyzers.frame_sampler import FrameSampler
from kove_engine.analyzers.motion_analyzer import MotionAnalyzer
from kove_engine.analyzers.scene_detector import SceneDetector
from kove_engine.analyzers.visual_analyzer import VisualAnalyzer
from kove_engine.classifier import Classifier
from kove_engine.forensics import analyze_sampled_sequence
from kove_engine.reference_analysis import analyze_reference_edit
from kove_engine.segment_builder import SegmentBuilder
from kove_engine.types import (
    FrameData,
    FrameDescription,
    SegmentMap,
)

logger = logging.getLogger(__name__)


class Orchestrator:
    def __init__(
        self,
        baseline_fps: float = 1.5,
        burst_fps: float = 10.0,
        scene_threshold: float = 0.3,
        on_progress: Callable[[dict], None] | None = None,
    ) -> None:
        self.scene_detector = SceneDetector(threshold=scene_threshold)
        self.frame_sampler = FrameSampler(baseline_fps=baseline_fps, burst_fps=burst_fps)
        self.motion_analyzer = MotionAnalyzer()
        self.audio_analyzer = AudioAnalyzer()
        self.face_analyzer = FaceAnalyzer()
        self.visual_analyzer = VisualAnalyzer()
        self.classifier = Classifier()
        self.segment_builder = SegmentBuilder()
        self.on_progress = on_progress

    def _emit(self, stage: str, message: str, **kwargs: object) -> None:
        if self.on_progress:
            self.on_progress({"stage": stage, "message": message, **kwargs})

    def analyze(self, video_path: str) -> SegmentMap:
        """Run full analysis while preserving the original segment-map API."""
        segment_map, _ = self.analyze_with_report(video_path)
        return segment_map

    def analyze_with_report(self, video_path: str) -> tuple[SegmentMap, dict]:
        """Run the full pipeline and return the segment map plus edit report."""
        video_id = Path(video_path).stem
        logger.info("Analyzing video: %s", video_path)

        self._emit("scene_detecting", "Detecting scene cuts...")
        scene_cuts = self.scene_detector.detect(video_path)
        logger.info("Detected %d scenes", len(scene_cuts))

        self._emit("extracting_frames", "Extracting frames...")
        frame_paths = self.frame_sampler.sample(video_path, scene_cuts)
        logger.info("Extracted %d frames", len(frame_paths))
        self._emit(
            "extracting_frames", f"Extracted {len(frame_paths)} frames", total=len(frame_paths)
        )

        duration = self._get_duration(video_path)

        frame_descriptions = self._analyze_frames(video_path, frame_paths, duration, scene_cuts)

        self._emit("building_segments", "Building segments...")
        segment_map = self.segment_builder.build(frame_descriptions, video_id, duration)

        self._emit("done", f"Analysis complete: {len(segment_map.segments)} segments")
        result = SegmentMap(videos=[segment_map])
        audio_results = [
            self.audio_analyzer.analyze(video_path, frame.timestamp, 1.0)
            for frame in frame_descriptions
        ]
        forensics = analyze_sampled_sequence(video_path, frame_paths, duration)
        return result, analyze_reference_edit(
            segment_map,
            frame_descriptions,
            audio_results,
            forensics=forensics,
        )

    def _analyze_frames(
        self,
        video_path: str,
        frame_paths: list[tuple[float, str]],
        duration: float,
        scene_cuts: list[tuple[float, float]],
    ) -> list[FrameDescription]:
        descriptions: list[FrameDescription] = []
        prev_frame_path: str | None = None
        total = len(frame_paths)

        for i, (timestamp, image_path) in enumerate(frame_paths):
            self._emit(
                "analyzing_frame",
                f"Analyzing frame {i + 1}/{total}",
                current=i + 1,
                total=total,
            )

            frame_data = FrameData(
                timestamp=timestamp,
                image_path=image_path,
                prev_frame_path=prev_frame_path,
            )

            motion = self.motion_analyzer.analyze(frame_data)
            audio = self.audio_analyzer.analyze(video_path, timestamp, 1.0)
            face = self.face_analyzer.analyze(image_path)
            visual = self.visual_analyzer.analyze(image_path)

            is_cut = self._is_scene_cut(timestamp, scene_cuts)

            result = self.classifier.classify(motion, audio, face, visual, is_cut)

            description = self._generate_description(
                result.scene_type.value, face, motion, audio, visual
            )

            fd = FrameDescription(
                timestamp=timestamp,
                description=description,
                scene_type=result.scene_type,
                motion_level=motion.motion_level,
                has_dialogue=audio.has_dialogue,
                confidence=result.confidence,
                motion_score=motion.raw_score,
                audio_rms_energy=audio.rms_energy,
                audio_bpm=audio.bpm,
                is_silence=audio.is_silence,
                has_music=audio.has_music,
                face_count=face.face_count,
                has_talking_head=face.has_talking_head,
                face_positions=face.face_positions,
                shot_boundary=is_cut,
            )
            descriptions.append(fd)

            prev_frame_path = image_path

        return descriptions

    def _generate_description(
        self,
        scene_type: str,
        face: object,
        motion: object,
        audio: object,
        visual: object,
    ) -> str:
        parts = [scene_type.replace("_", " ").title()]

        if hasattr(face, "face_count") and face.face_count > 0:
            parts.append(f"{face.face_count} person{'s' if face.face_count > 1 else ''} detected")

        if hasattr(motion, "motion_level"):
            level = motion.motion_level
            level_str = level.value if hasattr(level, "value") else str(level)
            parts.append(f"{level_str} motion")

        if hasattr(audio, "has_dialogue") and audio.has_dialogue:
            parts.append("speech active")
        elif hasattr(audio, "is_silence") and audio.is_silence:
            parts.append("silence")

        if hasattr(visual, "scene_setting"):
            parts.append(visual.scene_setting)

        if hasattr(visual, "dominant_colors") and visual.dominant_colors:
            colors = ", ".join(visual.dominant_colors[:3])
            parts.append(f"dominant colors: {colors}")

        return " - ".join(parts)

    def _is_scene_cut(self, timestamp: float, scene_cuts: list[tuple[float, float]]) -> bool:
        return any(abs(timestamp - start) <= 0.25 for start, _duration in scene_cuts)

    def _get_duration(self, video_path: str) -> float:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return float(result.stdout.strip())
        except Exception:
            return 0.0
