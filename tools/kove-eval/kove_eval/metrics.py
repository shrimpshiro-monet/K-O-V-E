"""The signals the scorecard is built from.

Rule this module exists to enforce: **measure with signals, not opinions.** Every
function here returns numbers derived from pixels or samples, and every one has a
sensitivity check in `kove_eval.selftest` (see `scorecard.py`) that proves it moves
when the thing it claims to measure changes. A metric that cannot separate a good
edit from a bad one is reported as such and is not used as a gate.

Where the repo already has the analyser, this calls it rather than reimplementing:
shot boundaries come from `kove_engine.analyzers.scene_detector.SceneDetector`
and the beat grid from `kove_engine.beat_grid`, both of which are the same code
the product runs.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

from .media import FrameReader, decode_audio, frames_at

# --------------------------------------------------------------------------- #
# Shot structure
# --------------------------------------------------------------------------- #

CUT_TIMES_CACHE: dict[str, list[float]] = {}


def shot_boundaries(
    video_path: str | Path, duration: float | None = None
) -> list[tuple[float, float]]:
    """Shots as **(start, duration)** pairs, straight from the engine's detector.

    The engine's contract is `(start_time, duration)` — see
    `SceneDetector.detect`'s docstring. Reading the second element as an end time
    produced 38 negative "shot lengths" out of 39 on the first real fixture and
    poisoned every shot-length metric in the scorecard. `spans_as_ranges()` is the
    only place that conversion happens now, and `test_metrics.py` pins the
    contract so it cannot drift back.
    """
    from kove_engine.analyzers.scene_detector import SceneDetector

    if duration is None:
        from .media import probe

        duration = probe(video_path).duration
    detector = SceneDetector()
    return detector.detect(str(video_path), duration)


def cut_times(boundaries: list[tuple[float, float]]) -> list[float]:
    """Every boundary start except the first (which is just the file's head)."""
    return [round(span[0], 4) for span in boundaries[1:]]


@dataclass
class BeatAlignment:
    """How a set of cut times sits against a beat grid."""

    evaluated: int
    on_beat: int
    on_beat_ratio: float | None
    median_offset_ms: float | None
    mean_abs_offset_ms: float | None
    tolerance_ms: int

    def as_dict(self) -> dict:
        return asdict(self)


BEAT_TOLERANCE_SECONDS = 0.04


def beat_times(path: str | Path) -> list[float]:
    """Beat times from the Python engine's tracker (librosa), for comparison.

    This is the tracker the *scorecard's* grid comes from; it is not the tracker
    the product uses (`BeatDetectionEngine` is, and it is measured through the
    bridge). Reporting both side by side is the point — they disagree, and the
    disagreement is a finding rather than a detail.
    """
    from . import repo

    repo.ensure_engine_importable()
    repo.ensure_tools_on_path()
    from kove_engine.beat_grid import extract_audio_track, track_beat_grid

    samples = extract_audio_track(str(path))
    if samples is None:
        return []
    return [float(beat) for beat in track_beat_grid(samples).beats]


def beat_alignment(
    cuts: list[float],
    beats: tuple[float, ...] | list[float],
    tolerance_s: float = BEAT_TOLERANCE_SECONDS,
) -> BeatAlignment:
    """Fraction of cuts landing on a beat, plus the signed median offset.

    The offset is signed so "late" and "early" can be told apart: a pipeline that
    consistently lands 30ms late is a different bug from one that scatters ±30ms.
    Cuts outside the measured span of the grid are excluded rather than counted as
    misses — beat trackers do not emit beats through an intro.
    """
    beat_array = np.asarray(sorted(beats), dtype=float)
    if beat_array.size == 0:
        return BeatAlignment(0, 0, None, None, None, int(tolerance_s * 1000))

    evaluated_offsets: list[float] = []
    span = beat_array[-1] - beat_array[0]
    for cut in cuts:
        if cut < beat_array[0] - tolerance_s or cut > beat_array[-1] + tolerance_s:
            continue
        nearest = float(beat_array[np.argmin(np.abs(beat_array - cut))])
        evaluated_offsets.append(cut - nearest)

    if not evaluated_offsets:
        return BeatAlignment(0, 0, None, None, None, int(tolerance_s * 1000))

    offsets = np.asarray(evaluated_offsets)
    on_beat = int(np.sum(np.abs(offsets) <= tolerance_s))
    return BeatAlignment(
        evaluated=len(evaluated_offsets),
        on_beat=on_beat,
        on_beat_ratio=on_beat / len(evaluated_offsets) if span > 0 else None,
        median_offset_ms=float(np.median(offsets) * 1000.0),
        mean_abs_offset_ms=float(np.mean(np.abs(offsets)) * 1000.0),
        tolerance_ms=int(tolerance_s * 1000),
    )


def spans_as_ranges(
    boundaries: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Convert the engine's (start, duration) shots into (start, end) ranges."""
    return [(start, start + duration) for start, duration in boundaries]


def shot_lengths(boundaries: list[tuple[float, float]]) -> np.ndarray:
    """Shot durations, in seconds.

    Takes the (start, duration) pairs `detect()` returns, so the durations are the
    second element — not a subtraction.
    """
    return np.asarray([max(0.0, duration) for _start, duration in boundaries], dtype=float)


def shot_length_quantiles(boundaries: list[tuple[float, float]]) -> dict[str, float]:
    """Quantiles of shot duration, in seconds (input is (start, duration))."""
    lengths = shot_lengths(boundaries)
    if lengths.size == 0:
        return {}
    return {
        "p10": float(np.percentile(lengths, 10)),
        "p50": float(np.percentile(lengths, 50)),
        "p90": float(np.percentile(lengths, 90)),
        "mean": float(np.mean(lengths)),
        "count": float(lengths.size),
    }


def shot_lengths_in_beats(
    boundaries: list[tuple[float, float]], bpm: float | None
) -> np.ndarray:
    if not bpm:
        return np.zeros(0)
    beats = shot_lengths(boundaries) * (bpm / 60.0)
    return beats


def distribution_distance(a: np.ndarray, b: np.ndarray) -> dict[str, float] | None:
    """Wasserstein-1 between two 1-D samples, in the samples' own units.

    Chosen over a histogram/chi-square comparison because shot lengths are
    continuous and mostly unimodal: the interesting difference is "the output
    cuts 0.4 beats later than the reference", which EMD reports directly and
    binning would blur.
    """
    if a.size == 0 or b.size == 0:
        return None

    def cdf(sample: np.ndarray, grid: np.ndarray) -> np.ndarray:
        sorted_sample = np.sort(sample)
        return np.searchsorted(sorted_sample, grid, side="right") / sorted_sample.size

    grid = np.linspace(min(a.min(), b.min()), max(a.max(), b.max()), 512)
    cdf_a, cdf_b = cdf(a, grid), cdf(b, grid)
    return {
        "emd": float(np.trapezoid(np.abs(cdf_a - cdf_b), grid)),
        "median_delta": float(np.median(b) - np.median(a)),
        "mean_delta": float(np.mean(b) - np.mean(a)),
    }


# --------------------------------------------------------------------------- #
# Colour
# --------------------------------------------------------------------------- #


def bgr_to_lab(frame_bgr: np.ndarray) -> np.ndarray:
    """uint8 BGR → float32 CIE-Lab (OpenCV's L in 0..100, a/b in ±127)."""
    lab = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2LAB)
    lab = lab.astype(np.float32)
    lab[..., 0] *= 100.0 / 255.0
    lab[..., 1] -= 128.0
    lab[..., 2] -= 128.0
    return lab


def delta_e_2000_pixels(lab_a: np.ndarray, lab_b: np.ndarray) -> np.ndarray:
    """Per-pixel CIEDE2000 ΔE between two Lab images of equal shape.

    CIEDE2000 rather than CIE76 because the target here is *visible* difference:
    CIE76 overstates differences in saturated blues and understates skin-tone
    shifts, and skin tones are exactly what step 2 has to protect.

    Symbol names follow the published formula (`L1`, `C_bar`, `R_T`, …) so it can
    be checked against the paper line by line; the linter's casing rule is off for
    this function.
    """
    L1, a1, b1 = lab_a[..., 0], lab_a[..., 1], lab_a[..., 2]
    L2, a2, b2 = lab_b[..., 0], lab_b[..., 1], lab_b[..., 2]

    C1 = np.sqrt(a1**2 + b1**2)
    C2 = np.sqrt(a2**2 + b2**2)
    C_bar = 0.5 * (C1 + C2)

    G = 0.5 * (1 - np.sqrt(C_bar**7 / (C_bar**7 + 25.0**7 + 1e-12)))
    a1p = (1 + G) * a1
    a2p = (1 + G) * a2
    C1p = np.sqrt(a1p**2 + b1**2)
    C2p = np.sqrt(a2p**2 + b2**2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360.0
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360.0

    dLp = L2 - L1
    dCp = C2p - C1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180, dhp - 360, np.where(dhp < -180, dhp + 360, dhp))
    dhp = np.where((C1p * C2p) == 0, 0.0, dhp)
    dHp = 2.0 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp / 2.0))

    Lp_bar = 0.5 * (L1 + L2)
    Cp_bar = 0.5 * (C1p + C2p)
    hp_bar = np.where(
        np.abs(h1p - h2p) > 180,
        (h1p + h2p + 360) / 2.0,
        (h1p + h2p) / 2.0,
    )
    hp_bar = np.where((C1p * C2p) == 0, h1p + h2p, hp_bar)

    T = (
        1
        - 0.17 * np.cos(np.radians(hp_bar - 30))
        + 0.24 * np.cos(np.radians(2 * hp_bar))
        + 0.32 * np.cos(np.radians(3 * hp_bar + 6))
        - 0.20 * np.cos(np.radians(4 * hp_bar - 63))
    )
    d_theta = 30.0 * np.exp(-(((hp_bar - 275) / 25.0) ** 2))
    R_C = 2.0 * np.sqrt(Cp_bar**7 / (Cp_bar**7 + 25.0**7 + 1e-12))
    S_L = 1 + (0.015 * (Lp_bar - 50) ** 2) / np.sqrt(20 + (Lp_bar - 50) ** 2)
    S_C = 1 + 0.045 * Cp_bar
    S_H = 1 + 0.015 * Cp_bar * T
    R_T = -np.sin(np.radians(2 * d_theta)) * R_C

    return np.sqrt(
        (dLp / S_L) ** 2
        + (dCp / S_C) ** 2
        + (dHp / S_H) ** 2
        + R_T * (dCp / S_C) * (dHp / S_H)
    )


def skin_mask(bgr: np.ndarray) -> np.ndarray:
    """Crude skin-tone mask (YCrCb range), used as a *proxy* for 'protect faces'.

    A real face detector is optional in this repo (mediapipe, `requirements-
    faces.txt`) and absent from a default install, so the scorecard reports both
    an all-pixels ΔE and a non-skin ΔE: if the grade shifts skin tones far more
    than everything else, the non-skin number stays low and the pair tells the
    story. It is a proxy and is labelled as one — mediapipe would be better and is
    the upgrade path.
    """
    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[..., 1]
    cb = ycrcb[..., 2]
    return (cr >= 133) & (cr <= 180) & (cb >= 77) & (cb <= 127)


@dataclass
class ColorComparison:
    delta_e_mean: float | None
    delta_e_median: float | None
    delta_e_p95: float | None
    delta_e_non_skin: float | None
    skin_fraction: float
    lab_hist_distance: float | None
    lab_mean_delta: dict[str, float] | None

    def as_dict(self) -> dict:
        return asdict(self)


def _lab_histogram(lab: np.ndarray, bins: int = 32) -> np.ndarray:
    channels = []
    for index, limits in enumerate(((0, 100), (-90, 90), (-90, 90))):
        hist, _ = np.histogram(lab[..., index], bins=bins, range=limits)
        total = hist.sum()
        channels.append(hist / total if total else hist.astype(float))
    return np.stack(channels)


def lab_histogram_distance(hist_a: np.ndarray, hist_b: np.ndarray) -> float:
    """1-D earth-mover distance per channel, averaged (L, a, b)."""
    distances = []
    for channel in range(hist_a.shape[0]):
        cdf_a = np.cumsum(hist_a[channel])
        cdf_b = np.cumsum(hist_b[channel])
        distances.append(float(np.sum(np.abs(cdf_a - cdf_b)) / hist_a.shape[1]))
    return float(np.mean(distances))


def compare_color(
    reference: str | Path,
    output: str | Path,
    timestamps: list[float],
    width: int = 320,
) -> ColorComparison:
    """ΔE and Lab-histogram distance at matched timestamps."""
    ref_frames = frames_at(reference, timestamps, width=width)
    out_frames = frames_at(output, timestamps, width=width)
    if not ref_frames or not out_frames:
        return ColorComparison(None, None, None, None, 0.0, None, None)

    pairs = list(zip(ref_frames, out_frames, strict=False))
    delta_e_all: list[np.ndarray] = []
    delta_e_non_skin: list[np.ndarray] = []
    skin_total = 0
    pixel_total = 0
    hist_distances: list[float] = []
    lab_deltas = {"L": [], "a": [], "b": []}

    for (_, ref_bgr), (_, out_bgr) in pairs:
        height = min(ref_bgr.shape[0], out_bgr.shape[0])
        w = min(ref_bgr.shape[1], out_bgr.shape[1])
        ref_bgr = ref_bgr[:height, :w]
        out_bgr = out_bgr[:height, :w]
        lab_ref = bgr_to_lab(ref_bgr)
        lab_out = bgr_to_lab(out_bgr)
        delta = delta_e_2000_pixels(lab_ref, lab_out)
        delta_e_all.append(delta)

        mask = skin_mask(ref_bgr)
        skin_total += int(mask.sum())
        pixel_total += mask.size
        if mask.sum() > 0:
            delta_e_non_skin.append(delta[~mask])

        hist_distances.append(
            lab_histogram_distance(_lab_histogram(lab_ref), _lab_histogram(lab_out))
        )
        for index, key in enumerate(("L", "a", "b")):
            lab_deltas[key].append(float(np.mean(lab_out[..., index] - lab_ref[..., index])))

    stacked = np.concatenate([d.reshape(-1) for d in delta_e_all])
    non_skin = (
        np.concatenate([d.reshape(-1) for d in delta_e_non_skin])
        if delta_e_non_skin
        else np.zeros(0)
    )
    return ColorComparison(
        delta_e_mean=float(np.mean(stacked)),
        delta_e_median=float(np.median(stacked)),
        delta_e_p95=float(np.percentile(stacked, 95)),
        delta_e_non_skin=float(np.mean(non_skin)) if non_skin.size else None,
        skin_fraction=skin_total / pixel_total if pixel_total else 0.0,
        lab_hist_distance=float(np.mean(hist_distances)),
        lab_mean_delta={key: float(np.mean(values)) for key, values in lab_deltas.items()},
    )


# --------------------------------------------------------------------------- #
# Motion: affine decomposition
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class MotionEvent:
    time: float
    kind: str  # punch-in | punch-out | push-in | pull-out | shake
    magnitude: float  # scale factor change, or translation amplitude in px

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class MotionTrace:
    times: np.ndarray
    scale: np.ndarray  # cumulative scale relative to window start
    rotation_deg: np.ndarray
    translation_px: np.ndarray


def affine_trace(
    video_path: str | Path,
    start: float = 0.0,
    end: float | None = None,
    sample_fps: float = 12.5,
    width: int = 160,
) -> MotionTrace:
    """Per-frame affine motion, decomposed from dense optical flow.

    Flow is fitted to `v = A x + t` by least squares over the whole frame (x
    normalised to ±1 so `A`'s determinant is a scale ratio, not a pixel count).
    Fitting the *whole* field rather than tracking features is what makes this
    work on the low-texture footage a phone shoot produces; a feature-based
    estimate simply has nothing to track there.

    Only the linear part's mean singular value is used for scale, and the
    antisymmetric part for rotation, so a simultaneous pan does not read as a
    zoom.
    """
    with FrameReader(video_path, width=width) as reader:
        step = 1.0 / sample_fps
        duration = end if end is not None else 10_000.0
        frames = reader.frames_between(start, start + duration, step)

    if len(frames) < 2:
        empty = np.zeros(0)
        return MotionTrace(empty, empty, empty, empty)

    grays = [cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) for _, frame in frames]
    times = np.asarray([timestamp for timestamp, _ in frames], dtype=float)
    height, width_px = grays[0].shape

    ys, xs = np.mgrid[0:height, 0:width_px]
    x_norm = (xs / (width_px / 2.0)) - 1.0
    y_norm = (ys / (height / 2.0)) - 1.0
    design = np.stack([x_norm.reshape(-1), y_norm.reshape(-1), np.ones(height * width_px)], axis=1)

    cumulative_scale = [1.0]
    rotations = [0.0]
    translations = [0.0]

    for previous, current in zip(grays, grays[1:], strict=False):
        flow = cv2.calcOpticalFlowFarneback(
            previous, current, None, 0.5, 3, 15, 3, 5, 1.2, 0
        )
        vx = flow[..., 0].reshape(-1)
        vy = flow[..., 1].reshape(-1)
        solution, *_ = np.linalg.lstsq(design, np.stack([vx, vy], axis=1), rcond=None)
        matrix = solution[:2, :].T  # 2x2 linear part
        translation = solution[2, :]

        singular = np.linalg.svd(matrix, compute_uv=False)
        step_scale = float(np.mean(singular))
        rotation = float(np.degrees(np.arctan2(matrix[1, 0] - matrix[0, 1], 2.0)))
        cumulative_scale.append(cumulative_scale[-1] * max(step_scale, 1e-3))
        rotations.append(rotation)
        translations.append(float(np.linalg.norm(translation)))

    return MotionTrace(
        times=times,
        scale=np.asarray(cumulative_scale),
        rotation_deg=np.asarray(rotations),
        translation_px=np.asarray(translations),
    )


def _smooth(values: np.ndarray, window: int) -> np.ndarray:
    return values if window < 2 else np.convolve(values, np.ones(window) / window, mode="same")


def detect_motion_events(
    trace: MotionTrace,
    shot_spans: list[tuple[float, float]] | None = None,
    punch_threshold: float = 0.04,
    push_threshold: float = 0.06,
    shake_threshold_px: float = 1.4,
) -> list[MotionEvent]:
    """Classify the scale trace into editor-recognisable moves.

    Thresholds are deliberately coarse and were calibrated against synthesised
    clips with known moves (see `selftest`): a punch-in is >=4% scale inside
    0.6s, a push is >=6% sustained over >=1.2s, and shake is alternating
    translation with the scale held. Encoding "what an editor would call a
    punch-in" as a number is the whole point — "the shot has energy" is not
    measurable.
    """
    if trace.times.size < 3:
        return []

    scale = _smooth(trace.scale, 3)
    translation = _smooth(trace.translation_px, 3)
    dt = float(np.median(np.diff(trace.times))) or 0.08
    events: list[MotionEvent] = []

    punch_window = max(1, int(round(0.6 / dt)))
    push_window = max(1, int(round(1.2 / dt)))

    # Punch-in / punch-out: a large fraction of change inside a short window.
    for index in range(trace.times.size):
        for window, kind_in, kind_out in (
            (punch_window, "punch-in", "punch-out"),
            (push_window, "push-in", "pull-out"),
        ):
            start = index - window
            if start < 0:
                continue
            change = scale[index] - scale[start]
            faster = (index + window) < trace.times.size and abs(
                scale[index + window] - scale[index]
            ) > abs(change)
            if faster:
                continue
            threshold = punch_threshold if kind_in.startswith("punch") else push_threshold
            if abs(change) >= threshold:
                events.append(
                    MotionEvent(
                        time=float(trace.times[start]),
                        kind=kind_in if change > 0 else kind_out,
                        magnitude=float(abs(change)),
                    )
                )

    # Collapse overlapping detections of the same kind: keep the largest.
    collapsed: list[MotionEvent] = []
    for event in sorted(events, key=lambda e: (e.time, e.kind)):
        if collapsed and collapsed[-1].kind == event.kind and event.time - collapsed[-1].time < 1.0:
            if event.magnitude > collapsed[-1].magnitude:
                collapsed[-1] = event
            continue
        collapsed.append(event)

    # Shake: alternating translation while the scale is flat.
    if trace.times.size > 6:
        scale_range = float(np.max(scale) - np.min(scale))
        if scale_range < punch_threshold:
            diffs = np.diff(translation)
            sign_flips = int(np.sum(np.diff(np.sign(diffs)) != 0))
            if translation.max() >= shake_threshold_px and sign_flips >= 4:
                peak_index = int(np.argmax(np.abs(diffs)))
                collapsed.append(
                    MotionEvent(
                        time=float(trace.times[peak_index]),
                        kind="shake",
                        magnitude=float(np.max(translation)),
                    )
                )

    return sorted(collapsed, key=lambda e: e.time)


def match_events(
    reference: list[MotionEvent], output: list[MotionEvent], tolerance_s: float = 0.3
) -> dict[str, float | int]:
    """Precision/recall/F1 of motion events, matched by kind within a tolerance."""
    matched_ref: set[int] = set()
    matched_out: set[int] = set()
    for out_index, out_event in enumerate(output):
        best = None
        for ref_index, ref_event in enumerate(reference):
            if ref_index in matched_ref or ref_event.kind != out_event.kind:
                continue
            delta = abs(ref_event.time - out_event.time)
            if delta <= tolerance_s and (best is None or delta < best[0]):
                best = (delta, ref_index)
        if best is not None:
            matched_ref.add(best[1])
            matched_out.add(out_index)

    true_positive = len(matched_ref)
    precision = true_positive / len(output) if output else 0.0
    recall = true_positive / len(reference) if reference else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "reference_events": len(reference),
        "output_events": len(output),
        "matched": true_positive,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


# --------------------------------------------------------------------------- #
# Transitions
# --------------------------------------------------------------------------- #


@dataclass
class TransitionMix:
    cut: int
    dissolve: int
    dip: int
    total: int

    def proportions(self) -> dict[str, float]:
        total = max(1, self.total)
        return {
            "cut": self.cut / total,
            "dissolve": self.dissolve / total,
            "dip": self.dip / total,
        }

    def as_dict(self) -> dict:
        return {**asdict(self), "proportions": self.proportions()}


def classify_transitions(
    video_path: str | Path,
    boundaries: list[tuple[float, float]],
    sample_fps: float = 12.5,
    width: int = 160,
) -> TransitionMix:
    """Classify each boundary as a hard cut, a dissolve, or a dip.

    A hard cut shows one frame-to-frame jump with no ramp; a dissolve shows a run
    of intermediate differences; a dip shows the frame's mean level falling to
    near black between two shots. Reading this off pixels means an unrendered
    transition cannot hide: if the plan says dissolve and the renderer produced a
    cut, the mix changes.
    """
    mix = TransitionMix(0, 0, 0, 0)
    if not boundaries:
        return mix

    with FrameReader(video_path, width=width) as reader:
        # Only the start matters here, so no conversion is needed.
        for start, _duration in boundaries[1:]:
            frames = reader.frames_between(start - 0.4, start + 0.4, 1.0 / sample_fps)
            if len(frames) < 4:
                mix.cut += 1
                mix.total += 1
                continue
            grays = [
                cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
                for _, frame in frames
            ]
            diffs = [float(np.mean(np.abs(b - a))) for a, b in zip(grays, grays[1:], strict=False)]
            diffs_array = np.asarray(diffs)
            means = np.asarray([float(np.mean(g)) for g in grays])
            mid = len(diffs) // 2

            peak_index = int(np.argmax(diffs_array))
            if peak_index == mid or np.count_nonzero(diffs_array > diffs_array.max() * 0.45) <= 2:
                mix.cut += 1
            elif means.min() < max(4.0, means.mean() * 0.25) and means[mid] < means.mean() * 0.5:
                mix.dip += 1
            else:
                mix.dissolve += 1
            mix.total += 1
    return mix


def transition_mix_distance(a: TransitionMix, b: TransitionMix) -> float | None:
    """Total variation distance between two transition mixes (0..1)."""
    if a.total == 0 or b.total == 0:
        return None
    pa, pb = a.proportions(), b.proportions()
    return float(0.5 * sum(abs(pa[key] - pb[key]) for key in pa))


# --------------------------------------------------------------------------- #
# Captions
# --------------------------------------------------------------------------- #


@dataclass
class CaptionWindows:
    windows: list[tuple[float, float]]
    count: int
    total_seconds: float

    def as_dict(self) -> dict:
        return {
            "count": self.count,
            "total_seconds": self.total_seconds,
            "windows": [[round(a, 3), round(b, 3)] for a, b in self.windows],
        }


def caption_text_energy(frame_bgr: np.ndarray, band_fraction: float = 0.28) -> float:
    """How much text-like structure sits in the caption band.

    Text is high-frequency and high-contrast in a narrow band; footage is not.
    The score combines a Laplacian energy with the count of small, wide contours,
    because either alone is fooled — film grain raises the Laplacian, and a busy
    sky raises contours.
    """
    height = frame_bgr.shape[0]
    band = frame_bgr[int(height * (1 - band_fraction)) :, :]
    if band.size == 0:
        return 0.0
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    laplacian = cv2.Laplacian(gray, cv2.CV_32F)
    energy = float(np.mean(np.abs(laplacian)))

    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    band_height, band_width = band.shape[:2]
    glyphs = 0
    for contour in contours:
        _x, _y, w, h = cv2.boundingRect(contour)
        if 2 <= h <= band_height * 0.6 and w <= band_width * 0.6 and w * h >= 4:
            glyphs += 1
    return energy * (1.0 + glyphs / 50.0)


def caption_windows(
    video_path: str | Path,
    sample_fps: float = 10.0,
    sensitivity: float = 3.0,
    min_seconds: float = 0.2,
    width: int = 320,
) -> CaptionWindows:
    """Timed windows where the caption band carries text.

    The threshold is relative to the file's own median band energy, so the same
    rule applies to a reference and to a render of it and a difference in the
    numbers is a difference in captions, not in brightness.
    """
    from .media import probe

    duration = probe(video_path).duration
    step = 1.0 / sample_fps
    with FrameReader(video_path, width=width) as reader:
        samples = reader.frames_between(0.0, max(0.0, duration - step * 0.5), step)

    if not samples:
        return CaptionWindows([], 0, 0.0)

    energies = np.asarray([caption_text_energy(frame) for _, frame in samples])
    baseline = float(np.median(energies)) or 1.0
    threshold = max(baseline * sensitivity, baseline + 1.0)
    active = energies > threshold

    windows: list[tuple[float, float]] = []
    run_start: float | None = None
    for (timestamp, _), is_active in zip(samples, active, strict=False):
        if is_active and run_start is None:
            run_start = timestamp
        elif not is_active and run_start is not None:
            if timestamp - run_start >= min_seconds:
                windows.append((run_start, timestamp))
            run_start = None
    if run_start is not None and samples[-1][0] - run_start >= min_seconds:
        windows.append((run_start, samples[-1][0] + step))

    return CaptionWindows(
        windows=windows,
        count=len(windows),
        total_seconds=float(sum(end - start for start, end in windows)),
    )


def caption_timing_error(
    reference: CaptionWindows, output: CaptionWindows
) -> dict[str, float | int | None]:
    """Match caption windows in time and report start/end error.

    Windows are matched greedily by start time within 1s. Unmatched reference
    captions are counted as missing, unmatched output captions as spurious —
    a caption that never rendered and one that rendered in the wrong place are
    different failures and the scorecard separates them.
    """
    remaining = list(range(len(reference.windows)))
    start_errors: list[float] = []
    end_errors: list[float] = []
    for start, end in output.windows:
        best = None
        for index in remaining:
            ref_start, ref_end = reference.windows[index]
            delta = abs(ref_start - start)
            if delta <= 1.0 and (best is None or delta < best[0]):
                best = (delta, index, ref_start, ref_end)
        if best is not None:
            _delta, index, ref_start, ref_end = best
            remaining.remove(index)
            start_errors.append((start - ref_start) * 1000.0)
            end_errors.append((end - ref_end) * 1000.0)

    matched = len(start_errors)
    return {
        "reference_count": reference.count,
        "output_count": output.count,
        "matched": matched,
        "missing": reference.count - matched,
        "spurious": output.count - matched,
        "mean_abs_start_error_ms": float(np.mean(np.abs(start_errors))) if start_errors else None,
        "mean_abs_end_error_ms": float(np.mean(np.abs(end_errors))) if end_errors else None,
        "median_start_error_ms": float(np.median(start_errors)) if start_errors else None,
    }


# --------------------------------------------------------------------------- #
# Audio
# --------------------------------------------------------------------------- #


@dataclass
class Loudness:
    integrated_lufs: float | None
    lra_lu: float | None
    true_peak_dbfs: float | None

    def as_dict(self) -> dict:
        return asdict(self)


def integrated_loudness(path: str | Path) -> Loudness:
    """EBU R128 integrated loudness and true peak, via ffmpeg's ebur128.

    **Take the last match, not the first.** ebur128 emits a progress line every
    100 ms and the line at t=0 reports `I: -70.0 LUFS` — its silence floor, because
    no audio has been measured yet. `re.search` returned that, so every file in the
    first baseline scored exactly -70.0 LUFS, reference and output alike, and the
    silence floor looked like agreement. The authoritative numbers are in the
    summary block at the very end, which is also the last occurrence.
    """
    import re

    from .ffmpeg import run

    result = run(["-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"])
    text = result.stderr

    def grab(pattern: str) -> float | None:
        matches = re.findall(pattern, text)
        return float(matches[-1]) if matches else None

    return Loudness(
        integrated_lufs=grab(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS"),
        lra_lu=grab(r"LRA:\s*(-?\d+(?:\.\d+)?)\s*LU"),
        true_peak_dbfs=grab(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS"),
    )


LOW_BAND_HZ = 220.0


def band_level_curve(
    path: str | Path, low_hz: float = LOW_BAND_HZ, window: float = 0.4
) -> tuple[np.ndarray, np.ndarray]:
    """(times, dBFS) for the low band only.

    The low band is the music-ducking proxy: a kick/bass line lives below speech
    (which is centred higher), so the level in this band during speech windows
    versus outside them measures how far the bed was pushed down. A full
    measurement would separate the stems — the renderer's own ducking gain is
    known when it renders (see `render.py`), and the scorecard uses this
    independent, signal-only read as the thing it checks that gain against.
    """
    samples, rate = decode_audio(path, sample_rate=16000)
    if samples.size == 0:
        return np.zeros(0), np.zeros(0)

    from scipy import signal as scipy_signal

    sos = scipy_signal.butter(4, low_hz / (rate / 2.0), btype="low", output="sos")
    low = scipy_signal.sosfiltfilt(sos, samples)
    hop = max(1, int(window * rate))
    count = max(1, len(low) // hop)
    trimmed = low[: count * hop].reshape(count, hop)
    rms = np.sqrt(np.mean(np.square(trimmed, dtype=np.float64), axis=1) + 1e-12)
    db = 20.0 * np.log10(np.maximum(rms, 1e-7))
    times = (np.arange(count) + 0.5) * window
    return times, db


def ducking_depth_db(
    path: str | Path, speech_windows: list[tuple[float, float]]
) -> float | None:
    """Median low-band level outside speech minus inside it, in dB."""
    if not speech_windows:
        return None
    times, db = band_level_curve(path)
    if times.size == 0:
        return None

    inside = np.zeros(times.size, dtype=bool)
    for start, end in speech_windows:
        inside |= (times >= start) & (times <= end)
    if not inside.any() or inside.all():
        return None
    return float(np.median(db[~inside]) - np.median(db[inside]))


def color_stats(
    video_path: str | Path,
    boundaries: list[tuple[float, float]] | None = None,
    sample_fps: float = 2.0,
    width: int = 320,
) -> dict:
    """LAB mean/std, globally and per shot.

    This is the measurement a LAB transfer needs: matching a reference's grade is
    matching the mean *and* the spread of each channel, because matching only the
    mean produces a flat copy — the difference between "same average colour" and
    "same contrast".
    """
    from .media import probe

    info = probe(video_path)
    spans = boundaries or [(0.0, info.duration)]
    spans = spans_as_ranges(spans) if boundaries else spans
    per_shot: list[dict] = []
    stacked: list[np.ndarray] = []

    with FrameReader(video_path, width=width) as reader:
        for start, end in spans:
            frames = reader.frames_between(start, end, 1.0 / sample_fps)
            if not frames:
                continue
            labs = np.stack([bgr_to_lab(frame) for _, frame in frames])
            flat = labs.reshape(-1, 3)
            stacked.append(flat)
            per_shot.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "l_mean": float(flat[:, 0].mean()),
                    "l_std": float(flat[:, 0].std()),
                    "a_mean": float(flat[:, 1].mean()),
                    "a_std": float(flat[:, 1].std()),
                    "b_mean": float(flat[:, 2].mean()),
                    "b_std": float(flat[:, 2].std()),
                }
            )

    if not stacked:
        return {"global": {}, "per_shot": []}
    all_pixels = np.concatenate(stacked)
    return {
        "global": {
            "L": {"mean": float(all_pixels[:, 0].mean()), "std": float(all_pixels[:, 0].std())},
            "a": {"mean": float(all_pixels[:, 1].mean()), "std": float(all_pixels[:, 1].std())},
            "b": {"mean": float(all_pixels[:, 2].mean()), "std": float(all_pixels[:, 2].std())},
        },
        "per_shot": per_shot,
    }
