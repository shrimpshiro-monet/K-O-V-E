import os
from unittest.mock import MagicMock, patch

import pytest

from kove_engine.orchestrator import Orchestrator
from kove_engine.types import MotionLevel, SegmentMap


def test_orchestrator_returns_segment_map():
    orchestrator = Orchestrator()

    with patch.object(orchestrator.scene_detector, "detect") as mock_detect, \
         patch.object(orchestrator.frame_sampler, "sample") as mock_sample, \
         patch.object(orchestrator.motion_analyzer, "analyze") as mock_motion, \
         patch.object(orchestrator.audio_analyzer, "analyze") as mock_audio, \
         patch.object(orchestrator.face_analyzer, "analyze") as mock_face, \
         patch.object(orchestrator.visual_analyzer, "analyze") as mock_visual, \
         patch("cv2.imread") as mock_imread:

        mock_detect.return_value = [(0.0, 5.0)]
        mock_sample.return_value = [(0.0, "/tmp/f0.jpg"), (1.0, "/tmp/f1.jpg")]
        mock_motion.return_value = MagicMock(motion_level=MotionLevel.LOW, raw_score=0.05)
        mock_audio.return_value = MagicMock(
            has_dialogue=False, is_silence=False,
            has_music=False, bpm=None, rms_energy=0.3,
        )
        mock_face.return_value = MagicMock(
            face_count=0, has_talking_head=False, face_positions=[],
        )
        mock_visual.return_value = MagicMock(
            brightness=0.5, dominant_colors=["#888888"],
            color_histogram=[0.1] * 48, scene_setting="indoor",
        )
        mock_imread.return_value = MagicMock()

        result = orchestrator.analyze("/fake/video.mp4")

    assert isinstance(result, SegmentMap)
    assert len(result.videos) == 1


def test_orchestrator_multiple_frames():
    orchestrator = Orchestrator()

    with patch.object(orchestrator.scene_detector, "detect") as mock_detect, \
         patch.object(orchestrator.frame_sampler, "sample") as mock_sample, \
         patch.object(orchestrator.motion_analyzer, "analyze") as mock_motion, \
         patch.object(orchestrator.audio_analyzer, "analyze") as mock_audio, \
         patch.object(orchestrator.face_analyzer, "analyze") as mock_face, \
         patch.object(orchestrator.visual_analyzer, "analyze") as mock_visual, \
         patch("cv2.imread") as mock_imread:

        mock_detect.return_value = [(0.0, 5.0)]
        mock_sample.return_value = [(i, f"/tmp/f{i}.jpg") for i in range(5)]
        mock_motion.return_value = MagicMock(
            motion_level=MotionLevel.LOW, raw_score=0.05,
        )
        mock_audio.return_value = MagicMock(
            has_dialogue=False, is_silence=False,
            has_music=False, bpm=None, rms_energy=0.3,
        )
        mock_face.return_value = MagicMock(
            face_count=0, has_talking_head=False, face_positions=[],
        )
        mock_visual.return_value = MagicMock(
            brightness=0.5, dominant_colors=["#888888"],
            color_histogram=[0.1] * 48, scene_setting="indoor",
        )
        mock_imread.return_value = MagicMock()

        result = orchestrator.analyze("/fake/video.mp4")

    assert len(result.videos[0].segments) >= 1


@pytest.mark.integration
def test_end_to_end_with_sample_video():
    """Integration test — requires ffmpeg and a real video file."""

    sample_video = os.environ.get("KOVE_TEST_VIDEO")
    if not sample_video:
        pytest.skip("Set KOVE_TEST_VIDEO to run integration test")

    orchestrator = Orchestrator()
    result = orchestrator.analyze(sample_video)

    assert isinstance(result, SegmentMap)
    assert len(result.videos) == 1

    vsm = result.videos[0]
    assert vsm.duration > 0
    assert len(vsm.segments) > 0

    for seg in vsm.segments:
        assert seg.id.startswith(f"{vsm.video_id}-seg-")
        assert seg.end_time >= seg.start_time
        assert 0.0 <= seg.confidence <= 1.0
        valid = ["talking", "action", "transition", "b-roll", "silence", "music"]
        assert seg.scene_type.value in valid

    json_str = result.model_dump_json()
    parsed = SegmentMap.model_validate_json(json_str)
    assert len(parsed.videos[0].segments) == len(vsm.segments)


def _patched_orchestrator():
    """Orchestrator with every external decoder mocked out."""
    orchestrator = Orchestrator()
    mocks = {
        "detect": patch.object(orchestrator.scene_detector, "detect"),
        "sample": patch.object(orchestrator.frame_sampler, "sample"),
        "motion": patch.object(orchestrator.motion_analyzer, "analyze"),
        "audio": patch.object(orchestrator.audio_analyzer, "analyze"),
        "face": patch.object(orchestrator.face_analyzer, "analyze"),
        "visual": patch.object(orchestrator.visual_analyzer, "analyze"),
        "imread": patch("cv2.imread"),
    }
    started = {name: mock.start() for name, mock in mocks.items()}
    started["detect"].return_value = [(0.0, 2.0), (2.0, 1.0)]
    started["sample"].return_value = [(0.0, "/tmp/f0.jpg"), (2.0, "/tmp/f1.jpg")]
    started["motion"].return_value = MagicMock(motion_level=MotionLevel.LOW, raw_score=0.05)
    started["audio"].return_value = MagicMock(
        has_dialogue=False, is_silence=False,
        has_music=False, bpm=None, rms_energy=0.3,
    )
    started["face"].return_value = MagicMock(
        face_count=0, has_talking_head=False, face_positions=[],
    )
    started["visual"].return_value = MagicMock(
        brightness=0.5, dominant_colors=["#888888"],
        color_histogram=[0.1] * 48, scene_setting="indoor",
    )
    started["imread"].return_value = MagicMock()
    return orchestrator, mocks, started


def test_analyze_with_report_pins_the_requested_video_id():
    orchestrator, mocks, started = _patched_orchestrator()
    try:
        segment_map, report = orchestrator.analyze_with_report(
            "/fake/video.mp4", video_id="my-id"
        )
    finally:
        for mock in mocks.values():
            mock.stop()

    assert segment_map.videos[0].video_id == "my-id"
    assert [video["videoId"] for video in [report]] == ["my-id"]
    assert report["analysisVersion"] == "1.2.0"


def test_analyze_with_report_falls_back_to_the_path_stem():
    orchestrator, mocks, _started = _patched_orchestrator()
    try:
        _segment_map, report = orchestrator.analyze_with_report("/fake/video.mp4")
    finally:
        for mock in mocks.values():
            mock.stop()

    assert report["videoId"] == "video"


def test_analyze_with_report_threads_scene_cuts_into_cut_evidence():
    orchestrator, mocks, _started = _patched_orchestrator()
    try:
        _segment_map, report = orchestrator.analyze_with_report(
            "/fake/video.mp4", video_id="my-id"
        )
    finally:
        for mock in mocks.values():
            mock.stop()

    assert report["editPattern"]["cutEvidence"] == [
        {"time": 0.0, "confidence": 0.9},
        {"time": 2.0, "confidence": 0.9},
    ]
    assert report["summary"]["cutCount"] == 1
    assert report["limitations"] == []


def test_audio_is_decoded_once_per_frame():
    orchestrator, mocks, started = _patched_orchestrator()
    try:
        orchestrator.analyze_with_report("/fake/video.mp4", video_id="my-id")
    finally:
        for mock in mocks.values():
            mock.stop()

    # Two sampled frames → two decodes. The old code decoded a second full
    # pass in analyze_with_report.
    assert started["audio"].call_count == 2
