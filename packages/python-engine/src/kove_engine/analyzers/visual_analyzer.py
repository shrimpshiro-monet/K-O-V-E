from __future__ import annotations

import cv2
import numpy as np
from sklearn.cluster import KMeans

from kove_engine.types import VisualResult


class VisualAnalyzer:
    def __init__(self, n_dominant_colors: int = 3, histogram_bins: int = 16) -> None:
        self.n_dominant_colors = n_dominant_colors
        self.histogram_bins = histogram_bins

    def analyze(self, image_path: str) -> VisualResult:
        """Extract visual features: brightness, histogram, dominant colors."""
        img = cv2.imread(image_path)
        if img is None:
            return VisualResult(
                brightness=0.0,
                dominant_colors=[],
                color_histogram=[0.0] * (self.histogram_bins * 3),
                scene_setting="dark",
            )

        brightness = self._compute_brightness(img)
        histogram = self._compute_histogram(img)
        dominant_colors = self._compute_dominant_colors(img)
        scene_setting = self._classify_setting(brightness, dominant_colors)

        return VisualResult(
            brightness=brightness,
            dominant_colors=dominant_colors,
            color_histogram=histogram,
            scene_setting=scene_setting,
        )

    def _compute_brightness(self, img: np.ndarray) -> float:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        return float(np.mean(gray)) / 255.0

    def _compute_histogram(self, img: np.ndarray) -> list[float]:
        hist = []
        for channel in range(3):
            h = cv2.calcHist([img], [channel], None, [self.histogram_bins], [0, 256])
            hist.extend(h.flatten().tolist())
        total = sum(hist)
        if total > 0:
            hist = [v / total for v in hist]
        return hist

    def _compute_dominant_colors(self, img: np.ndarray) -> list[str]:
        small = cv2.resize(img, (100, 100))
        pixels = small.reshape(-1, 3).astype(np.float32)
        n_clusters = min(self.n_dominant_colors, len(pixels))
        if n_clusters < 1:
            return []
        kmeans = KMeans(n_clusters=n_clusters, n_init=3, max_iter=100, random_state=42)
        kmeans.fit(pixels)
        colors = []
        for center in kmeans.cluster_centers_:
            r, g, b = int(center[0]), int(center[1]), int(center[2])
            colors.append(f"#{r:02x}{g:02x}{b:02x}")
        return colors

    def _classify_setting(self, brightness: float, dominant_colors: list[str]) -> str:
        if brightness < 0.3:
            return "dark"
        if brightness > 0.7:
            warm_count = 0
            for hex_color in dominant_colors:
                r = int(hex_color[1:3], 16)
                g = int(hex_color[3:5], 16)
                if r > g and r > 100:
                    warm_count += 1
            if warm_count > 0:
                return "outdoor"
        if brightness > 0.5:
            saturations = []
            for hex_color in dominant_colors:
                r = int(hex_color[1:3], 16)
                g = int(hex_color[3:5], 16)
                b = int(hex_color[5:7], 16)
                max_c = max(r, g, b)
                min_c = min(r, g, b)
                sat = (max_c - min_c) / max(max_c, 1)
                saturations.append(sat)
            if saturations and np.mean(saturations) > 0.5:
                return "studio"
        return "indoor"
