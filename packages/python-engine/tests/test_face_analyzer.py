from unittest.mock import MagicMock, patch

from kove_engine.analyzers.face_analyzer import FaceAnalyzer
from kove_engine.types import FaceResult

MOD = "kove_engine.analyzers.face_analyzer"


def test_no_faces():
    with patch(f"{MOD}.cv2") as mock_cv2:
        mock_cv2.imread.return_value = None
        mock_cv2.COLOR_BGR2RGB = 4
        with patch(f"{MOD}.mp") as mock_mp:
            mock_fd = MagicMock()
            mock_mp.solutions.face_detection.FaceDetection.return_value = mock_fd
            mock_fd.process.return_value = MagicMock(detections=None)
            analyzer = FaceAnalyzer()
            result = analyzer.analyze("/fake/frame.jpg")
    assert result.face_count == 0
    assert result.has_talking_head is False
    assert result.face_positions == []


def test_single_face():
    with patch(f"{MOD}.cv2") as mock_cv2:
        mock_cv2.imread.return_value = MagicMock()
        mock_cv2.cvtColor.return_value = MagicMock()

        bbox = MagicMock()
        bbox.xmin = 0.3
        bbox.ymin = 0.2
        bbox.width = 0.25
        bbox.height = 0.3

        detection = MagicMock()
        detection.location_data.relative_bounding_box = bbox

        with patch(f"{MOD}.mp") as mock_mp:
            mock_fd = MagicMock()
            mock_mp.solutions.face_detection.FaceDetection.return_value = mock_fd
            mock_fd.process.return_value = MagicMock(detections=[detection])
            analyzer = FaceAnalyzer()
            result = analyzer.analyze("/fake/frame.jpg")

    assert result.face_count == 1
    assert len(result.face_positions) == 1


def test_face_result_structure():
    with patch(f"{MOD}.cv2") as mock_cv2:
        mock_cv2.imread.return_value = MagicMock()
        mock_cv2.cvtColor.return_value = MagicMock()
        with patch(f"{MOD}.mp") as mock_mp:
            mock_fd = MagicMock()
            mock_mp.solutions.face_detection.FaceDetection.return_value = mock_fd
            mock_fd.process.return_value = MagicMock(detections=[])
            analyzer = FaceAnalyzer()
            result = analyzer.analyze("/fake/frame.jpg")
    assert isinstance(result, FaceResult)
