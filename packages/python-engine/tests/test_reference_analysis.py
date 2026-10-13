from kove_engine.beat_grid import BeatGrid
from kove_engine.reference_analysis import analyze_reference_edit
from kove_engine.types import (
    AudioResult,
    FrameDescription,
    MotionLevel,
    SceneType,
    VideoSegment,
    VideoSegmentMap,
)


def _two_shot_video(cut_at: float = 4.0) -> VideoSegmentMap:
    """An 8 s reference with a single cut."""
    return VideoSegmentMap(
        video_id="reference",
        duration=8.0,
        segments=[
            VideoSegment(
                id="one",
                start_time=0,
                end_time=cut_at,
                description="speaker",
                scene_type=SceneType.TALKING,
                motion_level=MotionLevel.STATIC,
                has_dialogue=True,
                visual_content="speaker",
                confidence=0.9,
            ),
            VideoSegment(
                id="two",
                start_time=cut_at,
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


def _grid_at_120bpm() -> BeatGrid:
    """120 BPM beats every 0.5 s on the half second, phase 0."""
    return BeatGrid(
        bpm=120.0,
        beats=tuple(round(0.5 * i, 3) for i in range(16)),
        downbeats=(0.0, 2.0, 4.0, 6.0),
        confidence=0.9,
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
    assert report["timeline"][0]["startTime"] == 0.0
    assert "b-roll coverage" in report["timeline"][1]["usedFor"]

    # Without a beat grid there is no tempo to report. The chunk BPM in the
    # audio fixtures is per-frame and no longer feeds detectedBpm.
    assert report["styleProfile"]["detectedBpm"] is None
    assert report["styleProfile"]["cutOnBeatRatio"] is None
    assert report["styleProfile"]["cutOffsetMs"] is None
    assert report["beatGrid"] is None


class TestCutAlignment:
    """Cut placement is measured against real beats, not a period guess.

    The previous implementation tested `start_time % beat_period` against a
    period derived from averaged chunk BPMs, which is only correct if a beat
    happens to land exactly on t=0.
    """

    def test_a_cut_on_the_beat_counts(self):
        report = analyze_reference_edit(
            _two_shot_video(cut_at=4.0), [], [], beat_grid=_grid_at_120bpm()
        )
        assert report["styleProfile"]["cutOnBeatRatio"] == 1.0
        assert report["styleProfile"]["cutOffsetMs"] == 0.0

    def test_a_cut_between_beats_does_not_count(self):
        report = analyze_reference_edit(
            _two_shot_video(cut_at=4.25), [], [], beat_grid=_grid_at_120bpm()
        )
        assert report["styleProfile"]["cutOnBeatRatio"] == 0.0

    def test_a_cut_slightly_early_counts_and_reports_a_negative_offset(self):
        # Editors often cut a frame or two before the beat so the change reads
        # as landing on it; 4.98 is 20 ms before the beat at 5.0.
        report = analyze_reference_edit(
            _two_shot_video(cut_at=4.98), [], [], beat_grid=_grid_at_120bpm()
        )
        assert report["styleProfile"]["cutOnBeatRatio"] == 1.0
        assert report["styleProfile"]["cutOffsetMs"] == -20.0

    def test_an_offset_beyond_the_tolerance_does_not_count(self):
        # 4.9 is 100 ms before the beat at 5.0, well outside the 40 ms window.
        report = analyze_reference_edit(
            _two_shot_video(cut_at=4.9), [], [], beat_grid=_grid_at_120bpm()
        )
        assert report["styleProfile"]["cutOnBeatRatio"] == 0.0
        assert report["styleProfile"]["cutOffsetMs"] == -100.0

    def test_a_cut_outside_the_measured_grid_is_excluded(self):
        # The grid stops at 7.5; a cut at 20 s is unknown, not off-beat, so it
        # must not drag the ratio toward zero.
        video = VideoSegmentMap(
            video_id="reference",
            duration=30.0,
            segments=[
                VideoSegment(
                    id="one", start_time=0, end_time=10, description="a",
                    scene_type=SceneType.B_ROLL, motion_level=MotionLevel.LOW,
                    has_dialogue=False, visual_content="a", confidence=0.8,
                ),
                VideoSegment(
                    id="two", start_time=20, end_time=30, description="b",
                    scene_type=SceneType.B_ROLL, motion_level=MotionLevel.LOW,
                    has_dialogue=False, visual_content="b", confidence=0.8,
                ),
            ],
        )
        report = analyze_reference_edit(video, [], [], beat_grid=_grid_at_120bpm())
        assert report["styleProfile"]["cutsInsideGrid"] == 0
        assert report["styleProfile"]["cutOnBeatRatio"] is None

    def test_detected_bpm_and_grid_come_from_the_tracker(self):
        report = analyze_reference_edit(
            _two_shot_video(), [], [], beat_grid=_grid_at_120bpm()
        )
        assert report["styleProfile"]["detectedBpm"] == 120.0
        assert report["beatGrid"]["bpm"] == 120.0
        assert report["beatGrid"]["firstBeatMs"] == 0
        assert report["beatGrid"]["beatsPerBar"] == 4
        assert len(report["beatGrid"]["downbeats"]) == 4