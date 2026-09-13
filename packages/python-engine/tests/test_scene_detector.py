from unittest.mock import MagicMock, patch

from kove_engine.analyzers.scene_detector import SceneDetector


def test_scene_detector_returns_list_of_tuples():
    detector = SceneDetector()
    mock_output = """
[Parsed_showinfo_1 @ 0x600002db8340] n:   0 pts:      0 pts_time:0       pos:        0
[Parsed_showinfo_1 @ 0x600002db8340] n:   1 pts:   3003 pts_time:1.001   pos:    45045
[Parsed_showinfo_1 @ 0x600002db8340] n:   2 pts:   9009 pts_time:3.003   pos:   135135
    """
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(stdout="", stderr=mock_output, returncode=0)
        result = detector.detect("/fake/video.mp4")

    assert isinstance(result, list)
    assert len(result) == 3
    assert all(isinstance(s, tuple) and len(s) == 2 for s in result)


def test_scene_detector_min_scene_duration():
    detector = SceneDetector(min_scene_duration=1.0)
    mock_output = """
[Parsed_showinfo_1 @ 0x600002db8340] n:   0 pts:      0 pts_time:0       pos:        0
[Parsed_showinfo_1 @ 0x600002db8340] n:   1 pts:   1500 pts_time:0.5     pos:    22500
[Parsed_showinfo_1 @ 0x600002db8340] n:   2 pts:   6006 pts_time:2.002   pos:    90090
    """
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(stdout="", stderr=mock_output, returncode=0)
        result = detector.detect("/fake/video.mp4")

    assert len(result) == 2


def test_scene_detector_handles_no_scene_changes():
    detector = SceneDetector()
    mock_output = """
[Parsed_showinfo_1 @ 0x600002db8340] n:   0 pts:      0 pts_time:0       pos:        0
    """
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(stdout="", stderr=mock_output, returncode=0)
        result = detector.detect("/fake/video.mp4")

    assert len(result) == 1


def test_scene_detector_ffmpeg_failure():
    detector = SceneDetector()
    with patch("subprocess.run") as mock_run:
        mock_run.side_effect = FileNotFoundError("ffmpeg not found")
        result = detector.detect("/fake/video.mp4")

    assert len(result) == 1
    assert result[0] == (0.0, 0.0)
