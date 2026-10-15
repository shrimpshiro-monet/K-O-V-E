from kove_engine.segment_builder import SegmentBuilder
from kove_engine.types import (
    FrameDescription,
    MotionLevel,
    SceneType,
    VideoSegmentMap,
)


def _make_frame(
    ts: float,
    scene_type: SceneType,
    motion: MotionLevel,
    shot_boundary: bool = False,
) -> FrameDescription:
    return FrameDescription(
        timestamp=ts,
        description=f"frame at {ts}",
        scene_type=scene_type,
        motion_level=motion,
        has_dialogue=False,
        confidence=0.8,
        shot_boundary=shot_boundary,
    )


def test_single_segment():
    builder = SegmentBuilder()
    frames = [
        _make_frame(0.0, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(0.5, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(1.0, SceneType.B_ROLL, MotionLevel.LOW),
    ]
    result = builder.build(frames, "vid1", 5.0)
    assert isinstance(result, VideoSegmentMap)
    assert len(result.segments) == 1
    assert result.segments[0].start_time == 0.0
    assert result.segments[0].end_time == 1.0


def test_aggregates_perception_signals():
    builder = SegmentBuilder()
    frames = [
        FrameDescription(
            timestamp=0.0,
            description="action frame",
            scene_type=SceneType.ACTION,
            motion_level=MotionLevel.HIGH,
            has_dialogue=False,
            confidence=0.9,
            motion_score=0.8,
            audio_rms_energy=0.4,
            audio_bpm=120.0,
            has_music=True,
            face_count=1,
            has_talking_head=True,
            shot_boundary=True,
        ),
        FrameDescription(
            timestamp=0.5,
            description="reaction frame",
            scene_type=SceneType.ACTION,
            motion_level=MotionLevel.HIGH,
            has_dialogue=False,
            confidence=0.8,
            motion_score=0.4,
            audio_rms_energy=0.6,
            audio_bpm=120.0,
            has_music=True,
            face_count=0,
        ),
    ]

    result = builder.build(frames, "vid1", 5.0)
    segment = result.segments[0]

    assert segment.motion_peak == 0.8
    assert segment.audio_energy == 0.5
    assert segment.audio_bpm == 120.0
    assert segment.beat_timestamps == [0.0, 0.5]
    assert segment.face_presence_ratio == 0.5
    assert segment.has_talking_head is True
    assert segment.shot_boundary_at_start is True
    assert segment.importance_score > 0


def test_scene_type_change_splits_segment():
    builder = SegmentBuilder()
    frames = [
        _make_frame(0.0, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(0.5, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(1.0, SceneType.TALKING, MotionLevel.LOW),
        _make_frame(1.5, SceneType.TALKING, MotionLevel.LOW),
    ]
    result = builder.build(frames, "vid1", 5.0)
    assert len(result.segments) == 2
    assert result.segments[0].scene_type == SceneType.B_ROLL
    assert result.segments[1].scene_type == SceneType.TALKING


def test_motion_change_splits_segment():
    builder = SegmentBuilder()
    frames = [
        _make_frame(0.0, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(0.5, SceneType.B_ROLL, MotionLevel.HIGH),
    ]
    result = builder.build(frames, "vid1", 5.0)
    assert len(result.segments) == 2


def test_time_gap_splits_segment():
    builder = SegmentBuilder()
    frames = [
        _make_frame(0.0, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(0.5, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(6.0, SceneType.B_ROLL, MotionLevel.LOW),
    ]
    result = builder.build(frames, "vid1", 10.0)
    assert len(result.segments) == 2


def test_empty_frames():
    builder = SegmentBuilder()
    result = builder.build([], "vid1", 5.0)
    assert len(result.segments) == 0


def test_shot_boundary_splits_segment_without_label_change():
    """A real cut splits even when scene type and motion level are identical."""
    builder = SegmentBuilder()
    frames = [
        _make_frame(0.0, SceneType.B_ROLL, MotionLevel.LOW),
        _make_frame(0.5, SceneType.B_ROLL, MotionLevel.LOW, shot_boundary=True),
        _make_frame(1.0, SceneType.B_ROLL, MotionLevel.LOW),
    ]
    result = builder.build(frames, "vid1", 5.0)

    assert len(result.segments) == 2
    assert result.segments[0].start_time == 0.0
    assert result.segments[0].end_time == 0.0
    assert result.segments[1].shot_boundary_at_start is True
    assert result.segments[1].end_time == 1.0
