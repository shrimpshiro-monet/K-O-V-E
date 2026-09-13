from kove_engine.classifier import Classifier
from kove_engine.types import (
    AudioResult,
    FaceResult,
    MotionLevel,
    MotionResult,
    SceneType,
    VisualResult,
)

HIST = [0.1] * 48


def _audio(**kw):
    defaults = dict(
        has_dialogue=False, is_silence=False,
        has_music=False, bpm=None, rms_energy=0.3,
    )
    defaults.update(kw)
    return AudioResult(**defaults)


def _face(**kw):
    defaults = dict(face_count=0, has_talking_head=False, face_positions=[])
    defaults.update(kw)
    return FaceResult(**defaults)


def _visual(**kw):
    defaults = dict(
        brightness=0.5, dominant_colors=["#888888"],
        color_histogram=HIST, scene_setting="indoor",
    )
    defaults.update(kw)
    return VisualResult(**defaults)


def test_talking_head_classification():
    classifier = Classifier()
    result = classifier.classify(
        motion=MotionResult(motion_level=MotionLevel.LOW, raw_score=0.05),
        audio=_audio(has_dialogue=True, rms_energy=0.4),
        face=_face(face_count=1, has_talking_head=True,
                    face_positions=[{"x": 0.3, "y": 0.2, "w": 0.4, "h": 0.5}]),
        visual=_visual(brightness=0.6, dominant_colors=["#8B4513"]),
        is_scene_cut_boundary=False,
    )
    assert result.scene_type == SceneType.TALKING


def test_action_classification():
    classifier = Classifier()
    result = classifier.classify(
        motion=MotionResult(motion_level=MotionLevel.HIGH, raw_score=0.35),
        audio=_audio(has_music=True, bpm=140, rms_energy=0.6),
        face=_face(),
        visual=_visual(brightness=0.7, dominant_colors=["#228B22"],
                        scene_setting="outdoor"),
        is_scene_cut_boundary=False,
    )
    assert result.scene_type == SceneType.ACTION


def test_silence_classification():
    classifier = Classifier()
    result = classifier.classify(
        motion=MotionResult(motion_level=MotionLevel.STATIC, raw_score=0.01),
        audio=_audio(is_silence=True, rms_energy=0.0),
        face=_face(),
        visual=_visual(brightness=0.3, dominant_colors=["#333333"],
                        scene_setting="dark"),
        is_scene_cut_boundary=False,
    )
    assert result.scene_type == SceneType.SILENCE


def test_transition_classification():
    classifier = Classifier()
    result = classifier.classify(
        motion=MotionResult(motion_level=MotionLevel.MEDIUM, raw_score=0.15),
        audio=_audio(),
        face=_face(),
        visual=_visual(),
        is_scene_cut_boundary=True,
    )
    assert result.scene_type == SceneType.TRANSITION


def test_broll_classification():
    classifier = Classifier()
    result = classifier.classify(
        motion=MotionResult(motion_level=MotionLevel.LOW, raw_score=0.05),
        audio=_audio(),
        face=_face(),
        visual=_visual(),
        is_scene_cut_boundary=False,
    )
    assert result.scene_type == SceneType.B_ROLL


def test_confidence_range():
    classifier = Classifier()
    result = classifier.classify(
        motion=MotionResult(motion_level=MotionLevel.MEDIUM, raw_score=0.15),
        audio=_audio(),
        face=_face(),
        visual=_visual(),
        is_scene_cut_boundary=False,
    )
    assert 0.0 <= result.confidence <= 1.0
