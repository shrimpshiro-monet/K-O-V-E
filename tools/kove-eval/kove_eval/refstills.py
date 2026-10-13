"""Measure a reference supplied as stills or as a frame-grid image.

Why this exists: the most useful reference material for this work arrives as
*stills* — a contact sheet of frames, a folder of screenshots, a grid someone
chopped a video into. Waiting for a clean video + music + beat grid before any
measurement is possible would mean the visual half of the craft gap (grade,
caption treatment, layout, pacing) stays unmeasured, and that half is what a
viewer actually notices.

What this can and cannot see:

* Can: frame size and aspect, LAB statistics per frame, where captions sit
  (which band of the frame carries text), whether a frame is a split-screen
  layout, and pacing *if* the stills are in play order with known timestamps.
* Cannot: anything that needs audio (LUFS, ducking, beat alignment) and anything
  that needs inter-frame continuity (transitions, camera moves). Those need the
  video. The profile says so explicitly rather than leaving a blank that reads as
  a zero.

A grid image has no timestamps. If the caller knows the frame interval, `fps` /
`interval_seconds` turns tile indices into times; without it, pacing numbers are
omitted rather than invented.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import metrics

# Bands used to say *where* text sits. The top band matters because editorial
# caption styles put the line above the subject's face, not below it — a system
# that only ever renders captions in the lower third cannot match those styles.
TEXT_BANDS = {
    "upper": (0.12, 0.40),
    "centre": (0.40, 0.62),
    "lower": (0.70, 0.94),
}


@dataclass
class StillsProfile:
    source: str
    frame_count: int
    size: list[int]
    aspect: float
    interval_seconds: float | None = None
    per_frame: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "frame_count": self.frame_count,
            "size": self.size,
            "aspect": self.aspect,
            "interval_seconds": self.interval_seconds,
            "per_frame": self.per_frame,
            "summary": self.summary(),
            "limits": [
                "no audio: LUFS and ducking depth need the video",
                "no inter-frame continuity: transitions and camera moves need the video",
                "pacing is only reported when the frame interval is known",
            ],
        }

    def summary(self) -> dict:
        if not self.per_frame:
            return {}
        l_values = [f["lab"]["L"]["mean"] for f in self.per_frame]
        std_values = [f["lab"]["L"]["std"] for f in self.per_frame]
        band_counts = {band: 0 for band in TEXT_BANDS}
        for frame in self.per_frame:
            for band, present in frame["text_bands"].items():
                if present:
                    band_counts[band] += 1
        layouts: dict[str, int] = {}
        for frame in self.per_frame:
            layouts[frame["layout"]] = layouts.get(frame["layout"], 0) + 1
        return {
            "L_mean": round(float(np.mean(l_values)), 3),
            "L_std_mean": round(float(np.mean(std_values)), 3),
            "shadow_fraction_under_L20": round(
                float(
                    np.mean(
                        [
                            f["lab"]["fraction_L_under_20"]
                            for f in self.per_frame
                        ]
                    )
                ),
                4,
            ),
            "highlight_fraction_over_L85": round(
                float(
                    np.mean(
                        [
                            f["lab"]["fraction_L_over_85"]
                            for f in self.per_frame
                        ]
                    )
                ),
                4,
            ),
            "frames_with_text": sum(
                1 for f in self.per_frame if any(f["text_bands"].values())
            ),
            "text_band_counts": band_counts,
            "layouts": layouts,
            "split_screen_frames": layouts.get("split-horizontal", 0)
            + layouts.get("split-vertical", 0),
        }


def _lab_stats(bgr: np.ndarray) -> dict:
    lab = metrics.bgr_to_lab(bgr)
    total = lab[..., 0].size

    def channel(index: int) -> dict:
        values = lab[..., index]
        return {"mean": round(float(values.mean()), 3), "std": round(float(values.std()), 3)}

    return {
        "L": channel(0),
        "a": channel(1),
        "b": channel(2),
        "fraction_L_under_20": round(float(np.count_nonzero(lab[..., 0] < 20) / total), 4),
        "fraction_L_over_85": round(float(np.count_nonzero(lab[..., 0] > 85) / total), 4),
    }


def band_text_energy(bgr: np.ndarray, low: float, high: float) -> float:
    """Text-likeness of a horizontal band (reuses the caption detector)."""
    height = bgr.shape[0]
    band = bgr[int(height * low) : int(height * high), :]
    if band.size == 0:
        return 0.0
    return metrics.caption_text_energy(band, band_fraction=1.0)


def detect_text_bands(bgr: np.ndarray, sensitivity: float = 2.2) -> dict[str, bool]:
    """Which bands carry text, judged against the frame's own texture level.

    Relative rather than absolute for the same reason the caption detector is:
    a dark frame and a bright frame should be judged by the same rule, so the
    comparison is against the whole-frame texture, not a fixed energy.
    """
    whole = metrics.caption_text_energy(bgr, band_fraction=1.0) + 1e-6
    presence = {}
    for name, (low, high) in TEXT_BANDS.items():
        energy = band_text_energy(bgr, low, high)
        presence[name] = energy > whole * sensitivity
    return presence


def classify_layout(bgr: np.ndarray, edge_fraction: float = 0.004) -> str:
    """`fullscreen`, `split-horizontal` (side by side) or `split-vertical`.

    A split is a near-stationary line where two panels meet: a thin column (or
    row) whose frame-to-frame texture is far below the frame's own, running the
    full height (or width) with content on both sides. Padded content (letterbox)
    is excluded by requiring content on both sides of the line.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    height, width = gray.shape
    if height < 32 or width < 32:
        return "fullscreen"

    column_energy = np.abs(np.diff(gray, axis=1)).mean(axis=0)
    row_energy = np.abs(np.diff(gray, axis=0)).mean(axis=1)
    threshold_x = float(np.median(column_energy)) * 0.25
    threshold_y = float(np.median(row_energy)) * 0.25

    quiet_columns = np.flatnonzero(column_energy < threshold_x)
    quiet_rows = np.flatnonzero(row_energy < threshold_y)

    def has_split(quiet: np.ndarray, extent: int, other: int) -> bool:
        if quiet.size == 0:
            return False
        # Group contiguous quiet lines.
        groups = np.split(quiet, np.flatnonzero(np.diff(quiet) > 1) + 1)
        for group in groups:
            position = float(group.mean()) / extent
            # Must be interior, thin, and leave real content on both sides.
            if 0.15 < position < 0.85 and group.size <= max(2, extent * edge_fraction):
                return True
        return False

    if has_split(quiet_columns, width, height):
        return "split-horizontal"
    if has_split(quiet_rows, height, width):
        return "split-vertical"
    return "fullscreen"


def split_grid(image: np.ndarray, max_tiles: int = 60) -> tuple[list[np.ndarray], tuple[int, int]]:
    """Cut a contact-sheet image into its tiles.

    Finds rows/columns that are uniform across the whole sheet (the gutters) and
    splits on them, then drops any tile too small to be a frame. Works for the
    common grids; a sheet with no gutters returns the image whole.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    height, width = gray.shape

    def gutters(axis: int) -> list[int]:
        # A gutter is a line whose variance along its length is tiny *and* whose
        # level is uniform — content rarely satisfies both.
        profile = gray.std(axis=axis)
        level = gray.mean(axis=axis)
        flat = (profile < 3.0) & (np.abs(level - np.median(level)) < 12.0)
        return np.flatnonzero(flat).tolist()

    def segments(blocked: list[int], extent: int) -> list[tuple[int, int]]:
        blocked_set = set(blocked)
        spans: list[tuple[int, int]] = []
        start = None
        for index in range(extent):
            if index in blocked_set:
                if start is not None and index - start > extent * 0.03:
                    spans.append((start, index))
                start = None
            elif start is None:
                start = index
        if start is not None and extent - start > extent * 0.03:
            spans.append((start, extent))
        return spans

    row_spans = segments(gutters(1), height)
    col_spans = segments(gutters(0), width)
    if len(row_spans) * len(col_spans) > 1:
        if len(row_spans) * len(col_spans) <= max_tiles:
            tiles = [
                image[r0:r1, c0:c1] for r0, r1 in row_spans for c0, c1 in col_spans
            ]
            return tiles, (len(row_spans), len(col_spans))

    # No gutters: most grids put tiles edge to edge, so find the boundaries by
    # content discontinuity instead. Two adjacent frames that do not belong to the
    # same shot differ far more at the seam than inside a frame, and the grid is
    # regular, so the seam spacing repeats — which is what makes this reliable
    # where a plain "biggest jump" search would latch onto a hard cut *inside* a
    # tile.
    return _split_by_period(image, max_tiles)


def _discontinuity(profile: np.ndarray) -> np.ndarray:
    """How different each adjacent pair of lines is, normalised."""
    values = np.abs(np.diff(profile))
    scale = float(np.median(values)) or 1.0
    return values / scale


def _seam_energy(gray: np.ndarray, axis: int) -> np.ndarray:
    """Per-line seam energy: |difference between adjacent lines| averaged over the
    other axis.

    Averaging the *difference* rather than differencing the *average* is the whole
    trick. Two unrelated frames meeting at a tile boundary differ on essentially
    every row, so the mean is large; an edge inside one frame differs on some rows
    only, so its mean stays modest. Differencing a row-averaged profile throws that
    distinction away and left the true boundaries scoring *below* the median.
    """
    return np.abs(np.diff(gray, axis=axis)).mean(axis=1 - axis)


def _lattice_score(energy: np.ndarray, extent: int, tiles: int) -> tuple[float, list[int]]:
    """How completely a `tiles`-way split is explained by strong seams.

    Scored as the fraction of the expected internal seams that actually show a
    local peak, which is what separates the true tile size from its submultiples:
    at half the true size every real seam still aligns, so a count-based score
    prefers the wrong answer, but only half of the *expected* seams exist there.
    """
    if tiles < 2:
        return 0.0, []
    boundaries = [int(round(extent * k / tiles)) for k in range(1, tiles)]
    window = max(2, int(extent * 0.01))
    threshold = float(np.percentile(energy, 80))
    found = []
    for boundary in boundaries:
        low = max(0, boundary - window)
        high = min(energy.size, boundary + window + 1)
        if high <= low:
            continue
        local = energy[low:high]
        if float(local.max()) >= threshold:
            found.append(boundary)
    return len(found) / len(boundaries), found


def _best_split(gray: np.ndarray, axis: int, extent: int, max_tiles: int = 12) -> int:
    """Number of tiles along `axis`, or 1 when no split is convincing."""
    energy = _seam_energy(gray, axis)
    best_score, best_tiles = 0.0, 1
    for tiles in range(2, max_tiles + 1):
        score, _found = _lattice_score(energy, extent, tiles)
        # Require the split to be nearly fully explained, then prefer the
        # coarsest split that qualifies — a finer one also aligns with a real grid
        # by chance.
        if score >= 0.75 and score > best_score + 1e-9:
            best_score, best_tiles = score, tiles
    return best_tiles if best_score >= 0.75 else 1


def _split_by_period(
    image: np.ndarray, max_tiles: int
) -> tuple[list[np.ndarray], tuple[int, int]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    height, width = gray.shape
    cols = _best_split(gray, 1, width)
    rows = _best_split(gray, 0, height)
    if cols * rows <= 1 or cols * rows > max_tiles:
        return [image], (1, 1)
    tile_width = width // cols
    tile_height = height // rows
    tiles = [
        image[r * tile_height : (r + 1) * tile_height, c * tile_width : (c + 1) * tile_width]
        for r in range(rows)
        for c in range(cols)
    ]
    return tiles, (rows, cols)


def profile_stills(
    frames: list[np.ndarray],
    source: str,
    interval_seconds: float | None = None,
) -> StillsProfile:
    """Measure every frame; returns the profile the scorecard compares against."""
    per_frame = []
    for index, frame in enumerate(frames):
        entry = {
            "index": index,
            "time": round(index * interval_seconds, 4) if interval_seconds else None,
            "size": [int(frame.shape[1]), int(frame.shape[0])],
            "aspect": round(float(frame.shape[1] / frame.shape[0]), 4),
            "lab": _lab_stats(frame),
            "text_bands": detect_text_bands(frame),
            "layout": classify_layout(frame),
            "band_energies": {
                name: round(band_text_energy(frame, low, high), 3)
                for name, (low, high) in TEXT_BANDS.items()
            },
        }
        per_frame.append(entry)

    first = frames[0]
    return StillsProfile(
        source=source,
        frame_count=len(frames),
        size=[int(first.shape[1]), int(first.shape[0])],
        aspect=round(float(first.shape[1] / first.shape[0]), 4),
        interval_seconds=interval_seconds,
        per_frame=per_frame,
    )


def profile_grid_image(
    image_path: Path, interval_seconds: float | None = None
) -> StillsProfile:
    """Profile a contact-sheet image, splitting it into tiles first."""
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f"could not read {image_path}")
    tiles, grid = split_grid(image)
    profile = profile_stills(tiles, source=str(image_path), interval_seconds=interval_seconds)
    profile.per_frame[0]["grid"] = list(grid) if profile.per_frame else []
    return profile


def profile_frame_dir(
    directory: Path, interval_seconds: float | None = None
) -> StillsProfile:
    """Profile a folder of stills, in filename order."""
    paths = sorted(
        p
        for p in directory.iterdir()
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    )
    frames = []
    for path in paths:
        image = cv2.imread(str(path))
        if image is not None:
            frames.append(image)
    if not frames:
        raise ValueError(f"no images in {directory}")
    return profile_stills(frames, source=str(directory), interval_seconds=interval_seconds)


def write_profile(profile: StillsProfile, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(profile.as_dict(), indent=2) + "\n")
    return out_path


def compare_profiles(reference: StillsProfile, output: StillsProfile) -> dict:
    """Compare an output's frames against a stills reference, frame by frame.

    Only the properties both sides can measure are compared: grade, darkness
    distribution, text band placement, and layout mix. Geometry (size/aspect)
    is reported separately because a vertical reference and a 16:9 output can
    still match on grade.
    """

    def mean_of(profile: StillsProfile, path: list[str]) -> float | None:
        values = []
        for frame in profile.per_frame:
            node: object = frame
            for key in path:
                if not isinstance(node, dict):
                    node = None
                    break
                node = node.get(key)
            if isinstance(node, (int, float)):
                values.append(float(node))
        return float(np.mean(values)) if values else None

    rows = {
        "reference_L_mean": mean_of(reference, ["lab", "L", "mean"]),
        "output_L_mean": mean_of(output, ["lab", "L", "mean"]),
        "reference_a_mean": mean_of(reference, ["lab", "a", "mean"]),
        "output_a_mean": mean_of(output, ["lab", "a", "mean"]),
        "reference_b_mean": mean_of(reference, ["lab", "b", "mean"]),
        "output_b_mean": mean_of(output, ["lab", "b", "mean"]),
        "reference_L_std": mean_of(reference, ["lab", "L", "std"]),
        "output_L_std": mean_of(output, ["lab", "L", "std"]),
        "reference_shadows": mean_of(reference, ["lab", "fraction_L_under_20"]),
        "output_shadows": mean_of(output, ["lab", "fraction_L_under_20"]),
        "reference_aspect": reference.aspect,
        "output_aspect": output.aspect,
    }
    reference_summary = reference.summary()
    output_summary = output.summary()
    rows["text_band_reference"] = reference_summary.get("text_band_counts")
    rows["text_band_output"] = output_summary.get("text_band_counts")
    rows["layout_reference"] = reference_summary.get("layouts")
    rows["layout_output"] = output_summary.get("layouts")
    rows["gaps"] = _name_gaps(rows)
    return rows


def _name_gaps(rows: dict) -> list[str]:
    """Say which differences are large enough to be worth stating."""
    gaps: list[str] = []
    for channel in ("L", "a", "b"):
        reference = rows.get(f"reference_{channel}_mean")
        output = rows.get(f"output_{channel}_mean")
        if reference is None or output is None:
            continue
        delta = output - reference
        threshold = 6.0 if channel == "L" else 4.0
        if abs(delta) > threshold:
            word = "brighter" if delta > 0 else "darker"
            if channel != "L":
                word = "warmer" if delta > 0 else "cooler"
                if channel == "a":
                    word = "redder" if delta > 0 else "greener"
            gaps.append(f"{channel}_mean {delta:+.2f} (output {word})")

    for key, label in (("shadows", "shadow fraction"), ("L_std", "contrast (L std)")):
        reference = rows.get(f"reference_{key}")
        output = rows.get(f"output_{key}")
        if reference is None or output is None:
            continue
        delta = output - reference
        if abs(delta) > (0.06 if key == "shadows" else 5.0):
            gaps.append(f"{label} {delta:+.3f}")

    reference_bands = rows.get("text_band_reference") or {}
    output_bands = rows.get("text_band_output") or {}
    for band in TEXT_BANDS:
        difference = (output_bands.get(band, 0)) - (reference_bands.get(band, 0))
        if abs(difference) > 0:
            direction = "more" if difference > 0 else "fewer"
            gaps.append(f"{band}-band captions: {difference:+d} ({direction} in output)")
    return gaps
