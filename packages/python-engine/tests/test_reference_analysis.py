from kove_engine.reference_analysis import analyze_reference_edit
from kove_engine.types import (
    AudioResult,
    FrameDescription,
    MotionLevel,
    SceneType,
    VideoSegment,
    VideoSegmentMap,
)


def test_reference_analysis_reports_pacing_and_timestamped_usage() -> None:
    video = VideoSegmentMap(
        video_id="reference",
        duration=8.0,
        segments=[
            VideoSegment(
                id="one",
                start_time=0,
                end_time=4,
                description="speaker",
                scene_type=SceneType.TALKING,
                motion_level=MotionLevel.STATIC,
                has_dialogue=True,
                visual_content="speaker",
                confidence=0.9,
            ),
            VideoSegment(
                id="two",
                start_time=4,
                end_time=8,
                description="b-roll",
                scene_type=SceneType.B_ROLL,
                motion_level=MotionLevel.HIGH,
                has_dialogue=False,
                visual_content="b-roll",
                confidence=0.8,
            ),
        ],
    )
    frames = [
        FrameDescription(
            timestamp=0,
            description="speaker",
            scene_type=SceneType.TALKING,
            motion_level=MotionLevel.STATIC,
            has_dialogue=True,
            confidence=0.9,
        ),
        FrameDescription(
            timestamp=4,
            description="b-roll",
            scene_type=SceneType.B_ROLL,
            motion_level=MotionLevel.HIGH,
            has_dialogue=False,
            confidence=0.8,
        ),
    ]
    audio = [
        AudioResult(
            has_dialogue=True,
            is_silence=False,
            has_music=False,
            bpm=None,
            rms_energy=0.5,
        ),
        AudioResult(
            has_dialogue=False,
            is_silence=False,
            has_music=True,
            bpm=120,
            rms_energy=0.5,
        ),
    ]

    report = analyze_reference_edit(video, frames, audio)

    assert report["analysisVersion"] == "1.1.0"
    assert report["summary"]["cutCount"] == 1
    assert report["summary"]["pacing"] == "moderate"
    assert report["styleProfile"]["cutsPerMinute"] == 7.5
    assert report["styleProfile"]["shotTypeDistribution"]["talking"] == 0.5
    assert report["styleProfile"]["detectedBpm"] == 120.0
    assert report["timeline"][0]["startTime"] == 0.0
    assert "b-roll coverage" in report["timeline"][1]["usedFor"]