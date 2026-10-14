"""Tests for reference measurement from stills.

`refstills` answers "what does the reference look like" when the reference arrives
as frames rather than as a video. Its weakest part is tile splitting: three
approaches were tried on a real sheet and all three failed before the fourth worked
(see F4 in docs/CRAFT_LOG.md), and the failure mode is silent — the whole sheet
comes back as one frame with a nonsense aspect ratio and no complaint. A wrong
split then poisons every downstream number: colour, bands, layout, pacing.

These tests pin the behaviour that matters: a grid whose tiles are visually distinct
splits, a single frame does not, and the seam score ranks a real seam above an edge
inside one frame.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kove_eval import refstills  # noqa: E402


def make_tile(size: int, seed: int) -> np.ndarray:
    """A frame-like tile: a gradient, a couple of shapes, mild grain.

    Deliberately not uniform pixel noise. Pure noise is adversarial to seam
    detection and unrepresentative of a frame — an actual video frame is smooth
    in most places, so a tile boundary stands out as a discontinuity against it.
    Testing against noise would have demanded a threshold that real material does
    not need.
    """
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    base = rng.integers(60, 200, size=3).astype(np.float32)
    image = np.zeros((size, size, 3), dtype=np.float32)
    for channel in range(3):
        image[..., channel] = base[channel] + (xx / size - 0.5) * 40 * (rng.random() * 2 - 1)
    for _ in range(2):
        cy, cx = rng.integers(size // 4, 3 * size // 4, 2)
        radius = rng.integers(size // 8, size // 3)
        mask = (yy - cy) ** 2 + (xx - cx) ** 2 < radius * radius
        image[mask] += rng.integers(-60, 60, 3)
    image += rng.normal(0, 3, (size, size, 3))
    return np.clip(image, 0, 255).astype(np.uint8)


def make_grid(rows: int, cols: int, tile: int = 120) -> np.ndarray:
    """Tiles that are visually unrelated — the case splitting must handle."""
    canvas = np.zeros((rows * tile, cols * tile, 3), dtype=np.uint8)
    seed = 0
    for row in range(rows):
        for col in range(cols):
            canvas[
                row * tile : (row + 1) * tile, col * tile : (col + 1) * tile
            ] = make_tile(tile, seed)
            seed += 1
    return canvas


class TestTileSplitting:
    def test_single_frame_is_not_split(self):
        image = make_grid(1, 1)
        tiles, (rows, cols) = refstills._split_by_period(image, 12)
        assert (rows, cols) == (1, 1)
        assert len(tiles) == 1

    @pytest.mark.parametrize("rows,cols", [(1, 4), (2, 2), (3, 2), (2, 3), (3, 3), (1, 6)])
    def test_visually_distinct_grid_splits_into_the_right_count(self, rows, cols):
        image = make_grid(rows, cols)
        tiles, (got_rows, got_cols) = refstills._split_by_period(image, 12)
        assert (got_rows, got_cols) == (rows, cols)
        assert len(tiles) == rows * cols

    def test_splitting_a_wide_strip_recovers_the_tile_aspect(self):
        """A 6x1 strip must come back as ~square tiles, not one 6:1 frame.

        The original bug returned the whole strip: one "frame" of aspect 3.556
        where each tile was 1:1, with no error and no warning.
        """
        image = make_grid(1, 6, tile=140)
        tiles, (rows, cols) = refstills._split_by_period(image, 12)
        assert (rows, cols) == (1, 6)
        height, width = tiles[0].shape[:2]
        assert width / height == pytest.approx(1.0, abs=0.05)

    def test_split_grid_prefers_gutters_when_the_sheet_has_them(self):
        """Gutters are unambiguous, so they win over seam detection."""
        tile = 100
        gutter = 8
        image = np.zeros((tile, 2 * tile + gutter, 3), dtype=np.uint8)
        image[:, :tile] = make_tile(tile, 11)
        image[:, tile + gutter :] = make_tile(tile, 12)
        tiles, (rows, cols) = refstills.split_grid(image)
        assert (rows, cols) == (1, 2)
        assert len(tiles) == 2


class TestSeamEnergy:
    def test_a_genuine_grid_clears_the_threshold_and_a_single_frame_does_not(self):
        """The discrimination the threshold exists for, asserted on both sides.

        Averaging the *difference* rather than differencing the *average* is the
        whole trick; getting it backwards put the true boundary below the median
        seam energy and made the split silently wrong. The statistic is the
        *weakest* seam, which is what separates a real grid from a single frame
        whose boundaries happen to land on shape edges.
        """
        grid = cv2.cvtColor(make_grid(1, 4), cv2.COLOR_BGR2GRAY).astype(np.float32)
        single = cv2.cvtColor(make_grid(1, 1, 240), cv2.COLOR_BGR2GRAY).astype(np.float32)
        grid_score = refstills._boundary_ratio(grid, 1, grid.shape[1], 4)
        single_best = max(
            refstills._boundary_ratio(single, 1, single.shape[1], n) for n in range(2, 7)
        )
        assert grid_score >= refstills.SEAM_RATIO_THRESHOLD
        assert single_best < refstills.SEAM_RATIO_THRESHOLD
        assert grid_score > single_best

    def test_a_boundary_index_reads_the_line_at_the_seam(self):
        """Off-by-one guard.

        `_seam_energy` is a diff, so the seam between tile k-1 and tile k is at
        `k*extent/tiles - 1`. Sampling one line later reads the first step inside
        the next tile, every ratio collapses to ~1, and no grid ever splits.
        """
        tile = 120
        image = make_grid(1, 4, tile=tile)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
        energy = refstills._seam_energy(gray, 1)
        at_seam = energy[2 * tile - 1]  # boundary between tiles 2 and 3
        just_inside = energy[2 * tile]
        assert at_seam > just_inside * 3

    def test_the_threshold_sits_above_what_a_single_frame_can_score(self):
        """The whole margin the threshold relies on, asserted directly."""
        gray = cv2.cvtColor(make_grid(1, 1, tile=240), cv2.COLOR_BGR2GRAY).astype(np.float32)
        worst = max(
            refstills._boundary_ratio(gray, 1, gray.shape[1], n) for n in range(2, 7)
        )
        assert worst < refstills.SEAM_RATIO_THRESHOLD


class TestLayout:
    def test_a_fullscreen_frame_is_not_called_split(self):
        assert refstills.classify_layout(make_grid(1, 1)) == "fullscreen"

    def test_two_panels_meeting_at_a_still_line_read_as_a_split(self):
        """A split is a thin, interior, near-stationary line with content either side.

        The panels are 400px wide because the seam is allowed to be only
        `edge_fraction` (0.4%) of the frame; a 4px gutter in a 404px frame is 1%
        and is correctly rejected as too thick to be a seam. The limit is a real
        one — the classifier will not see a seam thicker than about 0.4% of the
        frame — and worth knowing rather than papering over in a test.
        """
        left = make_tile(400, 31)
        right = make_tile(400, 32)
        gutter = np.zeros((400, 4, 3), dtype=np.uint8)
        assert refstills.classify_layout(np.hstack([left, gutter, right])) == "split-horizontal"

    def test_a_gutter_too_thick_to_be_a_seam_is_not_called_a_split(self):
        """The documented limit, pinned so it cannot drift unnoticed."""
        left = make_tile(200, 31)
        right = make_tile(200, 32)
        thick = np.zeros((200, 16, 3), dtype=np.uint8)
        assert refstills.classify_layout(np.hstack([left, thick, right])) == "fullscreen"


class TestTextBands:
    def test_text_in_the_lower_band_is_found_there(self):
        canvas = make_grid(1, 1, tile=320)
        band = canvas[240:285, 60:260]  # inside the "lower" band, 0.70-0.94
        band[:] = 255
        band[::2, :] = 0  # stroked, not solid: text is high-frequency
        presence = refstills.detect_text_bands(canvas)
        assert presence["lower"] is True
        assert presence["upper"] is False

    def test_a_blank_frame_has_no_text_bands(self):
        presence = refstills.detect_text_bands(np.zeros((300, 400, 3), dtype=np.uint8))
        assert not any(presence.values())


class TestProfile:
    def test_profiling_frames_reports_the_size_it_was_given(self):
        frames = [make_grid(1, 1), make_grid(1, 1)]
        profile = refstills.profile_stills(frames, source="test")
        assert profile.frame_count == 2
        assert profile.size == [frames[0].shape[1], frames[0].shape[0]]
        assert profile.aspect == pytest.approx(frames[0].shape[1] / frames[0].shape[0], abs=1e-3)

    def test_pacing_is_omitted_rather_than_invented_without_an_interval(self):
        profile = refstills.profile_stills([make_grid(1, 1)], source="test")
        assert profile.interval_seconds is None
        assert profile.per_frame[0]["time"] is None

    def test_an_empty_folder_is_an_error_not_an_empty_profile(self, tmp_path):
        with pytest.raises(ValueError):
            refstills.profile_frame_dir(tmp_path)
