from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def _round(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def _histogram(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [18, 8], [0, 180, 0, 256])
    return cv2.normalize(histogram, histogram).flatten()


def _frame_features(path: str) -> dict[str, Any] | None:
    image = cv2.imread(path)
    if image is None or not isinstance(image, np.ndarray) or image.ndim != 3:
        return None
    small = cv2.resize(image, (160, 90), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    return {
        "histogram": _histogram(small),
        "gray": gray,
        "brightness": float(np.mean(gray) / 255.0),
        "contrast": float(np.std(gray) / 128.0),
        "saturation": float(np.mean(hsv[:, :, 1]) / 255.0),
        "warmth": float(np.mean(small[:, :, 2]) - np.mean(small[:, :, 0])) / 255.0,
        "edgeDensity": float(np.count_nonzero(cv2.Canny(gray, 80, 160)) / gray.size),
    }


def _metadata(video_path: str) -> dict[str, Any]:
    command = [
        "ffprobe", "-v", "error", "-of", "json",
        "-show_format", "-show_streams", video_path,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        parsed = json.loads(result.stdout)
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        logger.warning("Could not read media metadata: %s", error)
        return {"available": False, "error": "ffprobe_unavailable"}

    streams = parsed.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    fps = _parse_ratio(video.get("r_frame_rate"))
    return {
        "available": True,
        "format": parsed.get("format", {}).get("format_name"),
        "codec": video.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "fps": _round(fps, 3) if fps else None,
        "frameCount": _integer(video.get("nb_frames")),
        "audioTracks": len(audio),
        "sampleRate": audio[0].get("sample_rate") if audio else None,
        "channels": audio[0].get("channels") if audio else None,
    }


def _parse_ratio(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        numerator, denominator = value.split("/", 1)
        return float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return None


def _integer(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def analyze_sampled_sequence(
    video_path: str,
    frame_paths: list[tuple[float, str]],
    duration: float,
    histogram_cut_threshold: float = 0.48,
) -> dict[str, Any]:
    """Analyze temporal evidence from real decoded frames.

    Detectors abstain when the sample cadence cannot support a reliable claim.
    """
    samples = [
        (timestamp, features)
        for timestamp, path in frame_paths
        if (features := _frame_features(path)) is not None
    ]
    transitions: list[dict[str, Any]] = []
    black_frames: list[dict[str, Any]] = []
    overlay_candidates: list[dict[str, Any]] = []
    effect_candidates: list[dict[str, Any]] = []
    deltas: list[float] = []

    for index, (timestamp, current) in enumerate(samples):
        if current["brightness"] < 0.035:
            black_frames.append({
                "startTime": _round(timestamp),
                "endTime": _round(min(duration, timestamp + 1.0)),
                "confidence": _round(min(1.0, (0.035 - current["brightness"]) / 0.035)),
            })
        # Persistent high edge density in the same lower-third region is useful
        # evidence for an overlay, but it is deliberately not called text locally.
        if current["edgeDensity"] > 0.16:
            overlay_candidates.append({
                "startTime": _round(timestamp),
                "region": "frame-wide",
                "kind": "graphic-or-text-candidate",
                "confidence": _round(min(0.8, current["edgeDensity"] * 3)),
                "requiresOcr": True,
            })
        if index == 0:
            continue
        previous = samples[index - 1][1]
        histogram_delta = float(cv2.compareHist(
            previous["histogram"], current["histogram"], cv2.HISTCMP_BHATTACHARYYA,
        ))
        brightness_delta = abs(current["brightness"] - previous["brightness"])
        delta = min(1.0, (histogram_delta * 0.75) + (brightness_delta * 0.25))
        deltas.append(delta)
        gap = max(0.0, timestamp - samples[index - 1][0])
        flow = cv2.calcOpticalFlowFarneback(
            previous["gray"], current["gray"], None, 0.5, 3, 15, 3, 5, 1.2, 0,
        )
        flow_magnitude, flow_angle = cv2.cartToPolar(flow[..., 0], flow[..., 1])
        mean_flow = float(np.mean(flow_magnitude))
        if mean_flow > 3.0 and gap <= 1.5:
            effect_candidates.append({
                "type": "camera-motion-or-whip-pan-candidate",
                "startTime": _round(samples[index - 1][0]),
                "endTime": _round(timestamp),
                "confidence": _round(min(0.7, mean_flow / 12.0)),
                "evidence": {
                    "meanOpticalFlow": _round(mean_flow),
                    "dominantDirection": _round(float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians(flow_angle))))))),
                },
                "requiresVision": True,
            })
        if delta >= histogram_cut_threshold:
            transition_type = "hard-cut" if gap <= 1.5 else "unknown-boundary"
            confidence = 0.82 if transition_type == "hard-cut" else 0.45
            if previous["brightness"] < 0.08 or current["brightness"] < 0.08:
                transition_type = "fade-to-black"
                confidence = 0.72
            transitions.append({
                "type": transition_type,
                "startTime": _round(timestamp),
                "endTime": _round(timestamp),
                "confidence": confidence,
                "evidence": {
                    "histogramDelta": _round(histogram_delta),
                    "brightnessDelta": _round(brightness_delta),
                    "sampleGap": _round(gap),
                },
            })

    if len(samples) < 2:
        temporal_quality = "insufficient-samples"
    elif duration > 0 and len(samples) / duration < 0.5:
        temporal_quality = "coarse-sampling"
    else:
        temporal_quality = "good"

    brightness = [item[1]["brightness"] for item in samples]
    saturation = [item[1]["saturation"] for item in samples]
    warmth = [item[1]["warmth"] for item in samples]
    return {
        "metadata": _metadata(video_path),
        "sampling": {
            "sampleCount": len(samples),
            "coverageSeconds": _round(duration),
            "temporalQuality": temporal_quality,
        },
        "transitions": transitions,
        "blackFrames": black_frames,
        "overlayCandidates": overlay_candidates,
        "effectCandidates": effect_candidates,
        "visualTreatment": {
            "brightness": _round(float(np.mean(brightness))) if brightness else None,
            "contrast": _round(float(np.mean([item[1]["contrast"] for item in samples]))) if samples else None,
            "saturation": _round(float(np.mean(saturation))) if saturation else None,
            "warmth": _round(float(np.mean(warmth))) if warmth else None,
            "consistency": _round(1.0 - min(1.0, float(np.std(brightness)) * 2)) if brightness else None,
            "description": _describe_color_treatment(brightness, saturation, warmth),
        },
        "motionEvidence": {
            "meanFrameDelta": _round(float(np.mean(deltas))) if deltas else None,
            "peakFrameDelta": _round(max(deltas)) if deltas else None,
        },
        "limitations": [
            "OCR and semantic effect names require the optional vision worker.",
            "Exact dissolve duration requires a denser sample window around each boundary.",
        ],
    }


def _describe_color_treatment(
    brightness: list[float], saturation: list[float], warmth: list[float]
) -> str:
    if not brightness:
        return "unknown"
    mean_brightness = float(np.mean(brightness))
    mean_saturation = float(np.mean(saturation))
    mean_warmth = float(np.mean(warmth))
    exposure = "low-key" if mean_brightness < 0.3 else "high-key" if mean_brightness > 0.7 else "balanced-exposure"
    color = "warm" if mean_warmth > 0.08 else "cool" if mean_warmth < -0.08 else "neutral"
    intensity = "saturated" if mean_saturation > 0.55 else "muted" if mean_saturation < 0.22 else "natural"
    return f"{exposure}, {color}, {intensity}"