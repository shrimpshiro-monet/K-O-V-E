"""The scorecard: everything measured, plus proof the measurements work.

Two things this module refuses to do:

1. **Score something it cannot separate.** `sensitivity()` perturbs a fixture in a
   known direction and checks the metric moves. A metric that passes is trusted; a
   metric that fails is reported as `"separates": false` and the scorecard says so
   rather than presenting a number that means nothing.
2. **Bury a gap in an average.** Every metric carries its own value for the
   reference and the output, so "the output is 0.4 beats off" is visible as a
   specific number next to the reference's own.

The comparison is always reference-vs-reference-rendered-through-the-pipeline. The
baseline column is that pair; a later step's column is the same pair after the
change, so a delta is always attributable to the change.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import metrics
from .contact_sheet import build_contact_sheet
from .media import probe


@dataclass
class MetricRow:
    name: str
    unit: str
    reference: float | None
    output: float | None
    #: True when a higher output value is closer to the reference.
    higher_is_better: bool
    #: reference vs output distance, in `unit`. Lower is better.
    distance: float | None
    separates: bool | None = None
    note: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReferenceScore:
    reference_id: str
    label: str
    output: str
    rows: list[MetricRow] = field(default_factory=list)
    extras: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "reference_id": self.reference_id,
            "label": self.label,
            "output": self.output,
            "metrics": [row.as_dict() for row in self.rows],
            "extras": self.extras,
            "notes": self.notes,
        }


def _error_row(
    name: str,
    unit: str,
    error: float | None,
    *,
    note: str = "",
) -> MetricRow:
    """A row whose target is zero: ΔE, an offset, a count of missing things.

    `reference` is left None rather than 0.0 on purpose. Printing "reference 0.000"
    for a colour difference reads as "the reference measured zero ΔE", which is
    meaningless, and on the first real scorecard that ambiguity hid the fact that
    the reference column was a constant. The unit says what zero means.
    """
    return MetricRow(
        name=name,
        unit=unit,
        reference=None,
        output=error,
        higher_is_better=False,
        distance=error,
        note=note or "0 is ideal",
    )


def _row(
    name: str,
    unit: str,
    reference: float | None,
    output: float | None,
    *,
    higher_is_better: bool = False,
    note: str = "",
) -> MetricRow:
    distance = None
    if reference is not None and output is not None:
        distance = abs(output - reference)
    return MetricRow(
        name=name,
        unit=unit,
        reference=reference,
        output=output,
        higher_is_better=higher_is_better,
        distance=distance,
        note=note,
    )


def score_pair(
    reference_path: Path,
    output_path: Path,
    *,
    reference_style: dict | None = None,
    out_dir: Path | None = None,
    reference_id: str = "",
    label: str = "",
    notes: list[str] | None = None,
) -> ReferenceScore:
    """Measure `output_path` against `reference_path` on every scorecard metric."""
    style = reference_style or {}
    ref_info = probe(reference_path)
    out_info = probe(output_path)

    rows: list[MetricRow] = []
    extras: dict = {}

    # ---- shot structure ------------------------------------------------ #
    ref_boundaries = metrics.shot_boundaries(reference_path, ref_info.duration)
    out_boundaries = metrics.shot_boundaries(output_path, out_info.duration)
    ref_quantiles = metrics.shot_length_quantiles(ref_boundaries)
    out_quantiles = metrics.shot_length_quantiles(out_boundaries)

    bpm = style.get("bpm")
    beat_period = 60.0 / bpm if bpm else None
    if beat_period:
        dist = metrics.distribution_distance(
            metrics.shot_lengths_in_beats(ref_boundaries, bpm),
            metrics.shot_lengths_in_beats(out_boundaries, bpm),
        )
        rows.append(
            _row(
                "shot_length_emd_beats",
                "beats",
                dist["emd"] if dist else None,
                0.0,
                note="earth-mover distance between the two shot-length distributions",
            )
        )
        rows.append(
            _row(
                "shot_length_median_beats",
                "beats",
                ref_quantiles.get("p50", 0.0) / beat_period,
                out_quantiles.get("p50", 0.0) / beat_period,
            )
        )
        rows.append(
            _row(
                "shot_length_p90_beats",
                "beats",
                ref_quantiles.get("p90", 0.0) / beat_period,
                out_quantiles.get("p90", 0.0) / beat_period,
            )
        )
    rows.append(_row("cut_count", "cuts", float(len(ref_boundaries)), float(len(out_boundaries))))

    # ---- rhythm -------------------------------------------------------- #
    ref_alignment = metrics.beat_alignment(style.get("beats") or [], style.get("beats") or [])
    ref_on_beat = style.get("on_beat_ratio")
    out_alignment = (
        metrics.beat_alignment(metrics.cut_times(out_boundaries), style["beats"])
        if style.get("beats")
        else None
    )
    rows.append(
        _row(
            "on_beat_ratio_40ms",
            "ratio",
            ref_on_beat,
            out_alignment.on_beat_ratio if out_alignment else None,
            higher_is_better=True,
        )
    )
    rows.append(
        _row(
            "median_cut_offset_ms",
            "ms",
            style.get("beat_offset_seconds", 0.0) * 1000.0 if style else None,
            out_alignment.median_offset_ms if out_alignment else None,
            note="signed: negative is early",
        )
    )
    rows.append(
        _row(
            "mean_abs_cut_offset_ms",
            "ms",
            None,
            out_alignment.mean_abs_offset_ms if out_alignment else None,
        )
    )
    extras["ref_alignment"] = ref_alignment.as_dict() if style.get("beats") else None
    extras["output_alignment"] = out_alignment.as_dict() if out_alignment else None

    # ---- colour -------------------------------------------------------- #
    timestamps = _sample_timestamps(ref_info.duration, out_info.duration)
    color = metrics.compare_color(reference_path, output_path, timestamps, width=320)
    color_dict = color.as_dict()
    extras["color"] = color_dict
    rows.append(_error_row("color_delta_e_mean", "dE", color.delta_e_mean))
    rows.append(_error_row("color_delta_e_p95", "dE", color.delta_e_p95))
    rows.append(
        _error_row(
            "color_delta_e_non_skin",
            "dE",
            color.delta_e_non_skin,
            note="grade error away from skin; a widening gap to the mean means the grade "
            "is eating faces",
        )
    )
    rows.append(_error_row("lab_histogram_distance", "emd", color.lab_hist_distance))
    extras["color_mean_delta_lab"] = color.lab_mean_delta

    # ---- motion -------------------------------------------------------- #
    ref_events = [metrics.MotionEvent(**e) for e in style.get("motion_events", [])]
    out_events: list[metrics.MotionEvent] = []
    for start, span in out_boundaries:
        if span < 0.5:
            continue
        trace = metrics.affine_trace(output_path, start=start, end=min(span, 2.2))
        out_events.extend(metrics.detect_motion_events(trace))
    match = metrics.match_events(ref_events, out_events)
    extras["motion"] = {**match, "output_events": [e.as_dict() for e in out_events]}
    rows.append(_row("motion_event_f1", "f1", 1.0, match["f1"], higher_is_better=True))
    missing_events = len(ref_events) - int(match["matched"])
    rows.append(_error_row("motion_events_missing", "events", float(max(0, missing_events))))
    spurious = len(out_events) - int(match["matched"])
    rows.append(_error_row("motion_events_spurious", "events", float(max(0, spurious))))

    # ---- transitions --------------------------------------------------- #
    ref_mix = metrics.TransitionMix(
        cut=int(style.get("transition_mix", {}).get("cut", 0)),
        dissolve=int(style.get("transition_mix", {}).get("dissolve", 0)),
        dip=int(style.get("transition_mix", {}).get("dip", 0)),
        total=int(style.get("transition_mix", {}).get("total", 0)),
    )
    out_mix = metrics.classify_transitions(output_path, out_boundaries)
    mix_distance = metrics.transition_mix_distance(ref_mix, out_mix)
    extras["transitions"] = {
        "reference": ref_mix.as_dict(),
        "output": out_mix.as_dict(),
    }
    rows.append(_error_row("transition_mix_tv_distance", "tv", mix_distance))

    # ---- captions ------------------------------------------------------ #
    out_captions = metrics.caption_windows(output_path)
    ref_caption = metrics.CaptionWindows(
        windows=[tuple(w) for w in style.get("caption_windows", [])],
        count=len(style.get("caption_windows", [])),
        total_seconds=float(
            sum(b - a for a, b in style.get("caption_windows", []))
        ),
    )
    caption_error = metrics.caption_timing_error(ref_caption, out_captions)
    extras["captions"] = {**caption_error, "output_windows": out_captions.as_dict()["windows"]}
    rows.append(
        _error_row(
            "caption_count_error",
            "captions",
            float(abs(caption_error["output_count"] - caption_error["reference_count"])),
        )
    )
    rows.append(_error_row("caption_missing", "captions", float(caption_error["missing"])))
    rows.append(
        _error_row(
            "caption_start_error_ms", "ms", caption_error["mean_abs_start_error_ms"]
        )
    )
    rows.append(
        _error_row("caption_end_error_ms", "ms", caption_error["mean_abs_end_error_ms"])
    )

    # ---- audio --------------------------------------------------------- #
    ref_loudness = metrics.integrated_loudness(reference_path)
    out_loudness = metrics.integrated_loudness(output_path)
    extras["loudness"] = {
        "reference": ref_loudness.as_dict(),
        "output": out_loudness.as_dict(),
    }
    rows.append(
        _row(
            "lufs",
            "LUFS",
            ref_loudness.integrated_lufs,
            out_loudness.integrated_lufs,
        )
    )
    rows.append(
        _row(
            "true_peak_dbfs",
            "dBFS",
            ref_loudness.true_peak_dbfs,
            out_loudness.true_peak_dbfs,
        )
    )
    speech_windows = [
        tuple(pair) for pair in (style.get("speech_windows") or _speech_windows(reference_path))
    ]
    ref_duck = style.get("duck_db")
    out_duck = metrics.ducking_depth_db(output_path, speech_windows) if speech_windows else None
    extras["ducking"] = {
        "reference_db": ref_duck,
        "output_db": out_duck,
        "speech_windows": [list(w) for w in speech_windows],
    }
    rows.append(_row("ducking_depth_db", "dB", ref_duck, out_duck))

    score = ReferenceScore(
        reference_id=reference_id or reference_path.stem,
        label=label,
        output=str(output_path),
        rows=rows,
        extras=extras,
        notes=list(notes or []),
    )

    if out_dir is not None:
        build_contact_sheet(
            reference_path,
            output_path,
            out_dir / f"{score.reference_id}.contact-sheet.png",
            extra_text=_contact_sheet_caption(score),
        )
    return score


def _speech_windows(reference_path: Path) -> list[tuple[float, float]]:
    ground_truth = reference_path.with_suffix(".groundtruth.json")
    if not ground_truth.exists():
        return []
    payload = json.loads(ground_truth.read_text())
    return [tuple(pair) for pair in payload.get("speech_windows", [])]


def _sample_timestamps(ref_duration: float, out_duration: float, count: int = 16) -> list[float]:
    """Evenly spaced timestamps inside both files, so neither runs off the end."""
    span = min(ref_duration, out_duration)
    if span <= 0:
        return [0.0]
    return [round(span * (index + 0.5) / count, 3) for index in range(count)]


def _contact_sheet_caption(score: ReferenceScore) -> str:
    interesting = {
        "color_delta_e_mean",
        "on_beat_ratio_40ms",
        "shot_length_median_beats",
        "motion_event_f1",
        "caption_missing",
        "ducking_depth_db",
    }
    parts = []
    for row in score.rows:
        if row.name not in interesting or row.output is None:
            continue
        reference = "—" if row.reference is None else f"{row.reference:.3f}"
        parts.append(f"{row.name}: ref {reference} vs out {row.output:.3f}")
    return " | ".join(parts)


# --------------------------------------------------------------------------- #
# Sensitivity: does each metric actually separate?
# --------------------------------------------------------------------------- #


@dataclass
class SensitivityCheck:
    metric: str
    perturbation: str
    perturbed_value: float
    control_value: float
    separates: bool
    detail: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def sensitivity(work_dir: Path) -> list[SensitivityCheck]:
    """Perturb a fixture and check the metrics move in the right direction.

    Each check builds the *same* clip twice, once clean and once with one property
    changed, and asserts the metric that claims to measure that property reports a
    bigger number for the changed one. A metric that fails this is reported as
    non-separating and must not be used as a gate.
    """
    from .compositor import CameraMove, Caption, Clip, Grade, Timeline, render_timeline

    work_dir.mkdir(parents=True, exist_ok=True)
    from .build import _golden_media_paths

    packs, track, voice = _golden_media_paths()
    pack_path = packs["portrait"]

    checks: list[SensitivityCheck] = []

    def make(name: str, *, grade: Grade | None = None, moves=None, captions=None,
             cut: float = 1.0, duck: float = 0.0, music_gain_db: float = 0.0) -> Path:
        clips = []
        cursor = 0.0
        for index in range(8):
            length = cut if index else cut
            clips.append(
                Clip(
                    source=pack_path,
                    source_start=index * 0.5,
                    source_end=index * 0.5 + length,
                    timeline_start=cursor,
                    grade=grade or Grade(),
                    moves=list(moves or []) if index == 2 else [],
                    captions=[
                        Caption(
                            text=c.text,
                            start=c.start,
                            end=c.end,
                            style=c.style,
                            position=c.position,
                        )
                        for c in (captions or [])
                    ]
                    if index == 2
                    else [],
                )
            )
            cursor += length
        timeline = Timeline(
            clips=clips,
            fps=25.0,
            size=(640, 360),
            music=str(track),
            music_gain=0.8 * (10.0 ** (music_gain_db / 20.0)),
            voice=str(voice) if voice else "",
            voice_gain=0.5 if voice else 0.0,
            speech_windows=[(0.3, 1.2)] if duck else [],
            duck_db=duck,
        )
        path = work_dir / f"{name}.mp4"
        render_timeline(timeline, path)
        return path

    # -- colour: a known grade must move ΔE ------------------------------- #
    clean = make("sens-clean")
    graded = make("sens-graded", grade=Grade(l_offset=12.0, b_offset=14.0, saturation=1.3))
    clean_vs_graded = metrics.compare_color(clean, graded, [0.5, 1.5, 2.5, 3.5], width=240)
    checks.append(
        SensitivityCheck(
            metric="color_delta_e_mean",
            perturbation="L +12, b +14, saturation ×1.3",
            perturbed_value=float(clean_vs_graded.delta_e_mean or 0.0),
            control_value=0.0,
            separates=bool((clean_vs_graded.delta_e_mean or 0.0) > 2.0),
            detail="a visible grade must register as several ΔE",
        )
    )

    # -- motion: a synthesised punch-in must be detected ------------------ #
    punch = make("sens-punch", moves=[CameraMove("punch-in", 0.0, 0.5, 0.18)])
    clean_events = metrics.detect_motion_events(metrics.affine_trace(clean, 1.0, 3.0))
    punch_events = metrics.detect_motion_events(metrics.affine_trace(punch, 1.0, 3.0))
    checks.append(
        SensitivityCheck(
            metric="motion_events",
            perturbation="0.18 punch-in inside shot 3",
            perturbed_value=float(len(punch_events)),
            control_value=float(len(clean_events)),
            separates=len(punch_events) > len(clean_events),
            detail=f"detected: {[e.kind for e in punch_events]}",
        )
    )

    # -- zoom magnitude: a bigger punch must read as bigger --------------- #
    small = make("sens-punch-small", moves=[CameraMove("punch-in", 0.0, 0.5, 0.06)])
    big = make("sens-punch-big", moves=[CameraMove("punch-in", 0.0, 0.5, 0.30)])
    small_events = metrics.detect_motion_events(metrics.affine_trace(small, 1.0, 3.0))
    big_events = metrics.detect_motion_events(metrics.affine_trace(big, 1.0, 3.0))
    small_mag = max((e.magnitude for e in small_events), default=0.0)
    big_mag = max((e.magnitude for e in big_events), default=0.0)
    checks.append(
        SensitivityCheck(
            metric="motion_event_magnitude",
            perturbation="punch intensity 0.06 → 0.30",
            perturbed_value=round(big_mag, 4),
            control_value=round(small_mag, 4),
            separates=big_mag > small_mag * 1.5,
            detail="magnitude must scale with the applied move",
        )
    )

    # -- captions: a caption must be seen -------------------------------- #
    with_caption = make(
        "sens-caption",
        captions=[Caption(text="measure this text", start=0.1, end=0.9, style="caption")],
    )
    clean_captions = metrics.caption_windows(clean, sample_fps=12.0)
    caption_result = metrics.caption_windows(with_caption, sample_fps=12.0)
    checks.append(
        SensitivityCheck(
            metric="caption_windows",
            perturbation="one caption rendered over shot 3",
            perturbed_value=float(caption_result.count),
            control_value=float(clean_captions.count),
            separates=caption_result.count > clean_captions.count,
            detail=f"windows: {caption_result.windows[:3]}",
        )
    )

    # -- beat alignment: off-grid cuts must score lower ------------------- #
    on_grid = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
    off_grid = [1.2, 2.2, 3.2, 4.2, 5.2, 6.2, 7.2]
    beats = tuple(float(x) for x in range(0, 10))
    on_alignment = metrics.beat_alignment(on_grid, beats)
    off_alignment = metrics.beat_alignment(off_grid, beats)
    checks.append(
        SensitivityCheck(
            metric="on_beat_ratio_40ms",
            perturbation="every cut moved 200ms off the beat",
            perturbed_value=float(off_alignment.on_beat_ratio or 0.0),
            control_value=float(on_alignment.on_beat_ratio or 0.0),
            separates=(on_alignment.on_beat_ratio or 0.0) > (off_alignment.on_beat_ratio or 0.0),
            detail="40ms tolerance must reject 200ms offsets",
        )
    )

    # -- shot length EMD: a different cut rate must register -------------- #
    emd_result = metrics.distribution_distance(
        np.asarray([1.0, 1.0, 1.0, 1.0]), np.asarray([2.0, 2.0, 2.0, 2.0])
    )
    checks.append(
        SensitivityCheck(
            metric="shot_length_emd_beats",
            perturbation="shot length 1.0 → 2.0 (constant)",
            perturbed_value=float(emd_result["emd"] if emd_result else 0.0),
            control_value=0.0,
            separates=bool(emd_result and emd_result["emd"] > 0.9),
            detail="EMD of constant 1-beat vs constant 2-beat shots must be ≈1",
        )
    )

    # -- ducking: a real duck must be measured ---------------------------- #
    no_duck = make("sens-duck-off", duck=0.0)
    ducked = make("sens-duck-on", duck=10.0)
    windows = [(0.3, 1.2)]
    off_depth = metrics.ducking_depth_db(no_duck, windows)
    on_depth = metrics.ducking_depth_db(ducked, windows)
    checks.append(
        SensitivityCheck(
            metric="ducking_depth_db",
            perturbation="music bed ducked 10dB under the voice",
            perturbed_value=round(float(on_depth or 0.0), 3),
            control_value=round(float(off_depth or 0.0), 3),
            separates=bool(
                on_depth is not None
                and off_depth is not None
                and on_depth > off_depth + 2.0
            ),
            detail="a 10dB duck must read as a positive depth",
        )
    )

    # -- loudness: 12 dB of gain must move LUFS by 12 LU -------------------- #
    #
    # The perturbation is applied to the DECODED AUDIO, not to the renderer, and
    # that is the whole point. Two earlier versions of this check were useless:
    # the first compared two renders whose audio was byte-identical and passed on
    # `is not None` (it reported -70.0 for both, ebur128's silence floor, and
    # called it agreement). The second applied -12 dB of music gain and measured
    # 0.20 LU of movement, because the renderer loudness-normalises its mix and
    # simply undid the change. That is correct behaviour for a product and a
    # useless experiment for a metric: this asks only "does ebur128 read 12 dB as
    # 12 LU", which is the property the scorecard depends on.
    loud_lufs = metrics.integrated_loudness(clean).integrated_lufs
    from .media import decode_audio, write_wav

    samples, rate = decode_audio(clean, sample_rate=48000)
    quiet_path = work_dir / "sens-quiet.wav"
    write_wav((samples * (10.0 ** (-12.0 / 20.0))).astype("float32"), rate, quiet_path)
    quiet_lufs = metrics.integrated_loudness(quiet_path).integrated_lufs
    delta = None if loud_lufs is None or quiet_lufs is None else abs(loud_lufs - quiet_lufs)
    checks.append(
        SensitivityCheck(
            metric="lufs",
            perturbation="music bed gain -12 dB",
            perturbed_value=round(float(quiet_lufs or 0.0), 3),
            control_value=round(float(loud_lufs or 0.0), 3),
            separates=bool(delta is not None and 10.0 <= delta <= 14.0),
            detail=(
                f"12 dB of gain must read as ~12 LU; got {delta:.2f} LU"
                if delta is not None
                else "ebur128 returned nothing"
            ),
        )
    )

    return checks
