from __future__ import annotations

import logging

import cv2

# face detection is optional. The core install stays on the headless OpenCV
# build so it needs no system OpenGL library, and mediapipe — which would drag
# in numpy<2 and a non-headless cv2 — lives in the `faces` extra instead.
#
# `mp` is deliberately left as a module-level global: tests patch
# `face_analyzer.mp`, and Python resolves the name at call time, so the patch
# still takes effect.
try:
    import mediapipe as mp
except ImportError:  # pragma: no cover - the real path is exercised in tests
    mp = None

from kove_engine.types import FaceResult

logger = logging.getLogger(__name__)

MEDIAPIPE_MISSING = (
    "mediapipe is not installed, so face detection is disabled and every frame "
    "reports zero faces. Follow the optional face-detection recipe in "
    "requirements-faces.txt (never install it alongside opencv-python-headless) "
    "to enable it."
)
MEDIAPIPE_API_MISSING = (
    "mediapipe is installed but does not expose mp.solutions.face_detection "
    "(the legacy Solutions API, removed in mediapipe 1.0). Face detection is "
    "disabled and every frame reports zero faces until the analyzer is migrated "
    "to the Tasks API."
)


class FaceAnalyzer:
    """Detect faces in a frame, degrading to zero faces when the backend is absent.

    Face detection is an enrichment, not a dependency: a missing or incompatible
    mediapipe must not take down the whole analysis pipeline, so an unusable
    backend is reported once through `available` and the log rather than raised.
    """

    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        model_selection: int = 0,
    ) -> None:
        self.min_detection_confidence = min_detection_confidence
        self.model_selection = model_selection
        self._face_detection = self._build_detector()

    @property
    def available(self) -> bool:
        """Whether a face-detection backend was successfully constructed."""
        return self._face_detection is not None

    def _build_detector(self):
        if mp is None:
            logger.warning(MEDIAPIPE_MISSING)
            return None

        try:
            return mp.solutions.face_detection.FaceDetection(
                model_selection=self.model_selection,
                min_detection_confidence=self.min_detection_confidence,
            )
        except AttributeError:
            # mediapipe 1.x dropped the Solutions API this analyzer was written
            # against. That is a version mismatch, not a transient error, so
            # degrade like the missing-package case instead of crashing.
            logger.warning(MEDIAPIPE_API_MISSING)
            return None

    def analyze(self, image_path: str) -> FaceResult:
        """Detect faces and classify talking head status."""
        if self._face_detection is None:
            return FaceResult(face_count=0, has_talking_head=False, face_positions=[])

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
