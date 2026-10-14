"""Where the cuts in a rendered file actually are, without a scene detector.

`metrics.shot_boundaries` answers "where are the cuts?" by segmenting the file —
it hunts for change points and reports what it found, so it can only be as
accurate as its own change-point model, and F18 measured it reading the
reference's known cut times **+17.1 ms late** (one frame at 60 fps, on a 25 fps
output). Every output-side timing number in the scorecard therefore carried that
bias, and there was no way to tell a late renderer from a late instrument.

This module answers a narrower, stronger question: *given* a list of times that
should be cuts, where is the nearest actual cut? It does not segment, does not
classify and does not decide how many cuts there are. It measures one number per
given time — the frame whose arrival differs most from the frame before it,
searched in a window around where the cut was asked for.

That makes it calibration as well as measurement: run it on a file whose cut
times are known exactly (the golden reference, or any file with a known
edit) and the deltas are the instrument's own error, with no renderer in the
path. Run it on a render and the deltas are instrument + renderer. The
difference between the two is the renderer's contribution, which is the whole
point of Step 3.

CONVENTION. A frame-difference at index `i` is the change between frame `i-1` and
frame `i`, so the cut is reported at `i / fps` — the presentation time of the
first frame that shows the new shot. With `t = i / fps` sampling, the earliest
frame that can show a cut planned at `T` is `ceil(T * fps)`, so a renderer that
is exactly on the plan still reports a delta in `[0, 1/fps)` — up to 40 ms at
25 fps, averaging half a frame. That is arithmetic, not a defect, and
`predicted_quantisation_delta` reports it per cut so the two can be compared
instead of confused.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class CutReading:
    """One planned cut, and where the file actually changes."""

    cut_id: int
    plan_time: float
    measured_time: float
    delta_seconds: float
    frame_index: int
    difference: float
    predicted_quantisation_delta_seconds: float
    confidence: float

    def as_dict(self) -> dict:
        return {
            "cut_id": self.cut_id,
            "plan_time": round(self.plan_time, 6),
            "measured_time": round(self.measured_time, 6),
            "delta_ms": round(self.delta_seconds * 1000.0, 3),
            "frame_index": self.frame_index,
            "frame_difference": round(self.difference, 6),
            "predicted_quantisation_ms": round(
                self.predicted_quantisation_delta_seconds * 1000.0, 3
            ),
            "residual_ms": round(
                (self.delta_seconds - self.predicted_quantisation_delta_seconds) * 1000.0, 3
            ),
            "confidence": round(self.confidence, 4),
        }


def frame_differences(path: str | Path) -> tuple[np.ndarray, float]:
    """Mean absolute frame-to-frame difference for the whole file, and its fps.

    `differences[i]` is the change between frame `i-1` and frame `i`, so index 0
    is always 0 (there is no frame before the first). Read in one sequential
    pass: seeking per cut is slower and, on some containers, less accurate.
    """
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise FileNotFoundError(f"cannot open video: {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS)) or 25.0

    values: list[float] = []
    previous: np.ndarray | None = None
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # Downscale: the decision is "did the picture change", and a 1/4-size
        # frame answers it with a quarter of the work and less encoder noise.
        small = cv2.resize(grey, (160, 90), interpolation=cv2.INTER_AREA)
        if previous is None:
            values.append(0.0)
        else:
            values.append(float(np.mean(np.abs(small.astype(np.float32) - previous))))
        previous = small.astype(np.float32)
    capture.release()
    return np.asarray(values, dtype=np.float64), fps


def read_cuts(
    path: str | Path,
    plan_times: list[float],
    *,
    window_seconds: float = 0.2,
    differences: np.ndarray | None = None,
    fps: float | None = None,
) -> list[CutReading]:
    """Locate the cut nearest each planned time, by frame difference.

    The search window is deliberately small (`window_seconds`, default 200 ms) and
    centred on the planned time. A wider window would find cuts belonging to other
    shots; a narrower one could not hold a real defect. Nothing here decides
    whether a cut exists — it reports the strongest change near the time asked
    about, and the confidence says how much stronger it was than the rest of the
    window.
    """
    if differences is None or fps is None:
        differences, fps = frame_differences(path)
    if len(differences) == 0:
        return []

    half_window = max(1, int(round(window_seconds * fps)))
    readings: list[CutReading] = []
    for cut_id, plan_time in enumerate(plan_times):
        centre = int(round(plan_time * fps))
        low = max(1, centre - half_window)
        high = min(len(differences) - 1, centre + half_window)
        if high < low:
            continue
        window = differences[low : high + 1]
        peak_offset = int(np.argmax(window))
        frame_index = low + peak_offset
        peak = float(window[peak_offset])

        # Confidence: the peak's share of the window's difference mass. A clean
        # cut owns most of it; a window that is mostly motion-noise reads low.
        mass = float(window.sum())
        confidence = peak / mass if mass > 0 else 0.0

        # The earliest frame that can show a cut planned at T.
        quantised = float(np.ceil(plan_time * fps)) / fps
        readings.append(
            CutReading(
                cut_id=cut_id,
                plan_time=plan_time,
                measured_time=frame_index / fps,
                delta_seconds=frame_index / fps - plan_time,
                frame_index=frame_index,
                difference=peak,
                predicted_quantisation_delta_seconds=quantised - plan_time,
                confidence=confidence,
            )
        )
    return readings


def summarise(readings: list[CutReading]) -> dict:
    """Median/mean/max delta and how much of it the frame grid explains."""
    if not readings:
        return {"count": 0}
    deltas = np.asarray([reading.delta_seconds for reading in readings])
    residuals = np.asarray(
        [
            reading.delta_seconds - reading.predicted_quantisation_delta_seconds
            for reading in readings
        ]
    )
    return {
        "count": len(readings),
        "delta_median_ms": round(float(np.median(deltas)) * 1000.0, 3),
        "delta_mean_ms": round(float(deltas.mean()) * 1000.0, 3),
        "delta_min_ms": round(float(deltas.min()) * 1000.0, 3),
        "delta_max_ms": round(float(deltas.max()) * 1000.0, 3),
        "predicted_median_ms": round(
            float(np.median([r.predicted_quantisation_delta_seconds for r in readings])) * 1000.0, 3
        ),
        "residual_median_ms": round(float(np.median(residuals)) * 1000.0, 3),
        "residual_mean_ms": round(float(residuals.mean()) * 1000.0, 3),
        "residual_min_ms": round(float(residuals.min()) * 1000.0, 3),
        "residual_max_ms": round(float(residuals.max()) * 1000.0, 3),
        "residual_spread_ms": round(float(residuals.max() - residuals.min()) * 1000.0, 3),
        "mean_confidence": round(float(np.mean([r.confidence for r in readings])), 4),
    }
