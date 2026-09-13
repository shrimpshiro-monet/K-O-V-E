from __future__ import annotations

import logging

import cv2
import mediapipe as mp

from kove_engine.types import FaceResult

logger = logging.getLogger(__name__)


class FaceAnalyzer:
    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        model_selection: int = 0,
    ) -> None:
        self.min_detection_confidence = min_detection_confidence
        self.model_selection = model_selection
        self._face_detection = mp.solutions.face_detection.FaceDetection(
            model_selection=model_selection,
            min_detection_confidence=min_detection_confidence,
        )

    def analyze(self, image_path: str) -> FaceResult:
        """Detect faces and classify talking head status."""
        img = cv2.imread(image_path)
        if img is None:
            return FaceResult(face_count=0, has_talking_head=False, face_positions=[])

        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        results = self._face_detection.process(rgb)

        if not results.detections:
            return FaceResult(face_count=0, has_talking_head=False, face_positions=[])

        face_positions = []
        has_talking = False

        for detection in results.detections:
            bbox = detection.location_data.relative_bounding_box
            pos = {
                "x": round(bbox.xmin, 4),
                "y": round(bbox.ymin, 4),
                "w": round(bbox.width, 4),
                "h": round(bbox.height, 4),
            }
            face_positions.append(pos)

            if 0.2 < bbox.xmin < 0.6 and bbox.width > 0.15:
                has_talking = True

        return FaceResult(
            face_count=len(results.detections),
            has_talking_head=has_talking,
            face_positions=face_positions,
        )
