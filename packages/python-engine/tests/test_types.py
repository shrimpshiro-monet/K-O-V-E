from kove_engine.types import (
    AudioResult,
    ClassifierResult,
    FaceResult,
    FrameData,
    FrameDescription,
    MotionLevel,
    MotionResult,
    SceneType,
    SegmentMap,
    VideoSegment,
    VideoSegmentMap,
    VisualResult,
)


def test_scene_type_enum_values():
    assert SceneType.TALKING == "talking"
    assert SceneType.ACTION == "action"
    assert SceneType.TRANSITION == "transition"
    assert SceneType.B_ROLL == "b-roll"
    assert SceneType.SILENCE == "silence"
    assert SceneType.MUSIC == "music"


def test_motion_level_enum_values():
    assert MotionLevel.STATIC == "static"
    assert MotionLevel.LOW == "low"
    assert MotionLevel.MEDIUM == "medium"
    assert MotionLevel.HIGH == "high"


def test_frame_description_creation():
    fd = FrameDescription(
        timestamp=1.5,
        description="test frame",
        scene_type=SceneType.TALKING,
        motion_level=MotionLevel.LOW,
        has_dialogue=True,
        confidence=0.85,
    )
    assert fd.timestamp == 1.5
    assert fd.scene_type == SceneType.TALKING
    assert fd.confidence == 0.85


def test_video_segment_creation():
    vs = VideoSegment(
        id="vid1-seg-0",
        start_time=0.0,
        end_time=5.0,
        description="test segment",
        scene_type=SceneType.B_ROLL,
        motion_level=MotionLevel.MEDIUM,
        has_dialogue=False,
        visual_content="frame1 | frame2",
        confidence=0.7,
    )
    assert vs.id == "vid1-seg-0"
    assert vs.end_time == 5.0


def test_segment_map_creation():
    sm = SegmentMap(
        videos=[
            VideoSegmentMap(
                video_id="vid1",
                duration=60.0,
                segments=[
                    VideoSegment(
                        id="vid1-seg-0",
                        start_time=0.0,
                        end_time=5.0,
                        description="seg",
                        scene_type=SceneType.B_ROLL,
                        motion_level=MotionLevel.LOW,
                        has_dialogue=False,
                        visual_content="x",
                        confidence=0.7,
                    )
                ],
            )
        ]
    )
    assert len(sm.videos) == 1
    assert sm.videos[0].duration == 60.0


def test_frame_data_creation():
    fd = FrameData(timestamp=2.0, image_path="/tmp/frame.jpg")
    assert fd.timestamp == 2.0
    assert fd.audio_path is None
    assert fd.prev_frame_path is None


def test_motion_result_creation():
    mr = MotionResult(motion_level=MotionLevel.HIGH, raw_score=0.35)
    assert mr.motion_level == MotionLevel.HIGH


def test_audio_result_creation():
    ar = AudioResult(
        has_dialogue=True, is_silence=False, has_music=False, bpm=None, rms_energy=0.5
    )
    assert ar.has_dialogue is True
    assert ar.bpm is None


def test_face_result_creation():
    fr = FaceResult(
        face_count=2, has_talking_head=True, face_positions=[{"x": 0, "y": 0, "w": 100, "h": 100}]
    )
    assert fr.face_count == 2


def test_visual_result_creation():
    vr = VisualResult(
        brightness=0.6,
        dominant_colors=["#FF0000", "#00FF00"],
        color_histogram=[0.1] * 48,
        scene_setting="indoor",
    )
    assert len(vr.dominant_colors) == 2


def test_classifier_result_creation():
    cr = ClassifierResult(
        scene_type=SceneType.ACTION, confidence=0.9, reasoning="high motion detected"
    )
    assert cr.scene_type == SceneType.ACTION
