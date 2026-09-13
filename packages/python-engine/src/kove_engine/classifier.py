from __future__ import annotations

from kove_engine.types import (
    AudioResult,
    ClassifierResult,
    FaceResult,
    MotionLevel,
    MotionResult,
    SceneType,
    VisualResult,
)


class Classifier:
    def classify(
        self,
        motion: MotionResult,
        audio: AudioResult,
        face: FaceResult,
        visual: VisualResult,
        is_scene_cut_boundary: bool,
    ) -> ClassifierResult:
        """Classify frame into scene type using heuristic rules."""
        if face.face_count > 0 and audio.has_dialogue:
            conf = 0.9 * min(1.0, face.face_count * 0.5) * min(1.0, audio.rms_energy * 2)
            return ClassifierResult(
                scene_type=SceneType.TALKING,
                confidence=round(conf, 3),
                reasoning=(
                    f"face_count={face.face_count}, "
                    f"speech active, rms={audio.rms_energy:.2f}"
                ),
            )

        if motion.motion_level == MotionLevel.HIGH:
            conf = 0.85 * min(1.0, motion.raw_score * 3)
            return ClassifierResult(
                scene_type=SceneType.ACTION,
                confidence=round(conf, 3),
                reasoning=f"high motion: score={motion.raw_score:.3f}",
            )

        if audio.is_silence and motion.motion_level == MotionLevel.STATIC:
            conf = 0.8 * (1.0 - audio.rms_energy)
            return ClassifierResult(
                scene_type=SceneType.SILENCE,
                confidence=round(conf, 3),
                reasoning="silence + static frame",
            )

        if audio.has_music and motion.motion_level in (MotionLevel.LOW, MotionLevel.MEDIUM):
            conf = 0.8 * min(1.0, (audio.bpm or 100) / 120)
            return ClassifierResult(
                scene_type=SceneType.MUSIC,
                confidence=round(conf, 3),
                reasoning=f"music detected, bpm={audio.bpm}, motion={motion.motion_level.value}",
            )

        if is_scene_cut_boundary:
            return ClassifierResult(
                scene_type=SceneType.TRANSITION,
                confidence=0.95,
                reasoning="scene cut boundary detected",
            )

        avg_conf = (1.0 - motion.raw_score + visual.brightness + audio.rms_energy) / 3
        return ClassifierResult(
            scene_type=SceneType.B_ROLL,
            confidence=round(max(0.5, min(0.9, avg_conf)), 3),
            reasoning=(
                f"no specific match: motion={motion.motion_level.value}, "
                f"brightness={visual.brightness:.2f}"
            ),
        )
