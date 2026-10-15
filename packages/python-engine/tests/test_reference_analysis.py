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

    assert report["analysisVersion"] == "1.2.0"
    assert report["summary"]["cutCount"] == 1
    assert report["summary"]["pacing"] == "moderate"
    assert report["styleProfile"]["cutsPerMinute"] == 7.5
    assert report["styleProfile"]["shotTypeDistribution"]["talking"] == 0.5
    assert report["styleProfile"]["detectedBpm"] == 120.0
    assert report["timeline"][0]["startTime"] == 0.0
    assert "b-roll coverage" in report["timeline"][1]["usedFor"]

def _report_with_cuts(scene_cuts, duration=3.0):
    """Minimal video/frames/audio triple whose labels never change."""
    video = VideoSegmentMap(
        video_id="reference",
        duration=duration,
        segments=[
            VideoSegment(
                id="one",
                start_time=0,
                end_time=duration,
                description="flat",
                scene_type=SceneType.B_ROLL,
                motion_level=MotionLevel.STATIC,
                has_dialogue=False,
                visual_content="flat",
                confidence=0.9,
            ),
        ],
    )
    frames = [
        FrameDescription(
            timestamp=0.0,
            description="flat",
            scene_type=SceneType.B_ROLL,
            motion_level=MotionLevel.STATIC,
            has_dialogue=False,
            confidence=0.9,
        ),
    ]
    audio = [
        AudioResult(
            has_dialogue=False,
            is_silence=False,
            has_music=False,
            bpm=None,
            rms_energy=0.4,
        ),
    ]
    return analyze_reference_edit(video, frames, audio, scene_cuts=scene_cuts)


def test_scene_cuts_drive_cut_count_and_evidence():
    report = _report_with_cuts([(0.0, 2.0), (2.0, 1.0)])

    # Sample gaps cannot express this: one frame means zero observed gaps.
    assert report["summary"]["cutCount"] == 1
    assert len(report["editPattern"]["cutEvidence"]) == 2
    assert report["editPattern"]["cutEvidence"][0] == {"time": 0.0, "confidence": 0.9}
    assert report["editPattern"]["cutEvidence"][1] == {"time": 2.0, "confidence": 0.9}
    assert report["limitations"] == []


def test_median_shot_duration_comes_from_cut_durations_not_sample_gaps():
    report = _report_with_cuts([(0.0, 2.0), (2.0, 1.0)])

    assert report["styleProfile"]["medianShotDuration"] == 1.5
    # 1.5s is the fast cutoff, so cut-driven pacing says "fast" where the
    # single-observation fallback could only say "unknown".
    assert report["styleProfile"]["pacing"] == "fast"
    assert report["styleProfile"]["cutsPerMinute"] == 20.0


def test_final_scene_duration_is_capped_at_media_duration():
    # The detector's synthetic 10s tail would otherwise claim a 10s last shot.
    report = _report_with_cuts([(0.0, 2.0), (2.0, 10.0)], duration=4.0)

    assert report["styleProfile"]["medianShotDuration"] == 2.0


def test_missing_scene_cuts_reports_the_limitation():
    report = _report_with_cuts(None)

    assert report["editPattern"]["cutEvidence"] == []
    assert report["limitations"] == ["cut-evidence-unavailable"]
    # Segment-map fallback still produces a cut count.
    assert report["summary"]["cutCount"] == 0
