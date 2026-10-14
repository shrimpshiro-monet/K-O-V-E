from __future__ import annotations

import numpy as np
import pytest

from kove_engine.beat_grid import (
    BEAT_TOLERANCE_SECONDS,
    BeatGrid,
    _grid_confidence,
    empty_beat_grid,
    track_beat_grid,
)

# --- helpers ---------------------------------------------------------------


def click_track(bpm: float, seconds: float, sr: int = 16000, click_ms: float = 20.0):
    """A metronomic click track: the ideal input for a beat tracker."""
    samples = np.zeros(int(sr * seconds), dtype=np.float32)
    period = 60.0 / bpm
    click_samples = int(sr * click_ms / 1000)
    window = np.hanning(click_samples).astype(np.float32)

    position = 0.0
    while position < seconds:
        start = int(round(position * sr))
        end = min(start + click_samples, len(samples))
        if end > start:
            samples[start:end] += window[: end - start]
        position += period
    return samples


#: A hand-built 120 BPM grid starting exactly at zero.
GRID = BeatGrid(
    bpm=120.0,
    beats=(0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5),
    downbeats=(0.0, 2.0),
    confidence=0.9,
)


# --- the grid as a measurement tool ----------------------------------------


class TestOffsets:
    def test_offset_is_zero_on_a_beat(self):
        assert GRID.offset_ms(1.5) == pytest.approx(0.0)

    def test_offset_is_negative_before_the_beat(self):
        # Editors habitually cut a frame or two early so the change reads as
        # landing on the beat; the sign has to be preserved to measure that.
        assert GRID.offset_ms(1.48) == pytest.approx(-20.0, abs=0.5)

    def test_offset_is_positive_after_the_beat(self):
        assert GRID.offset_ms(1.52) == pytest.approx(20.0, abs=0.5)

    def test_offset_uses_the_nearest_beat(self):
        assert GRID.offset_ms(0.76) == pytest.approx(-240.0, abs=0.5)

    def test_offset_is_none_without_a_grid(self):
        assert empty_beat_grid().offset_ms(1.0) is None


class TestOnBeat:
    def test_exact_beat_is_on_beat(self):
        assert GRID.is_on_beat(2.0)

    def test_within_tolerance_is_on_beat(self):
        assert GRID.is_on_beat(2.0 + BEAT_TOLERANCE_SECONDS / 2)

    def test_outside_tolerance_is_not_on_beat(self):
        assert not GRID.is_on_beat(2.0 + 0.1)

    def test_tolerance_defaults_to_the_playbook_value(self):
        assert BEAT_TOLERANCE_SECONDS == pytest.approx(0.04)

    def test_a_cut_a_frame_early_at_60fps_still_counts(self):
        # 1/60 s == 16.7 ms, the granularity editors actually work at.
        assert GRID.is_on_beat(2.0 - 1 / 60)

    def test_no_grid_is_never_on_beat(self):
        assert not empty_beat_grid().is_on_beat(2.0)


class TestDownbeats:
    def test_downbeat_is_recognised(self):
        assert GRID.is_on_downbeat(2.0)

    def test_mid_bar_beat_is_not_a_downbeat(self):
        assert not GRID.is_on_downbeat(1.5)

    def test_downbeat_offset_reported(self):
        assert GRID.downbeat_offset_ms(1.98) == pytest.approx(-20.0, abs=0.5)


class TestCoverage:
    """Times outside the measured span are unknown, not off-beat.

    The tracker starts emitting beats a little after the track begins and
    stops before the end. Counting those regions as "missed" beats would make
    every track look less on-beat than it is.
    """

    def test_covered_inside_the_span(self):
        assert GRID.is_covered(1.0)

    def test_covered_within_one_beat_of_the_edge(self):
        assert GRID.is_covered(-0.4)

    def test_not_covered_well_before_the_first_beat(self):
        assert not GRID.is_covered(-2.0)

    def test_not_covered_well_after_the_last_beat(self):
        assert not GRID.is_covered(9.0)

    def test_offset_is_none_outside_the_span(self):
        assert GRID.offset_ms(-2.0) is None
        assert GRID.offset_ms(9.0) is None

    def test_outside_the_span_is_not_on_beat(self):
        assert not GRID.is_on_beat(9.0)

    def test_outside_the_span_is_not_a_downbeat(self):
        assert not GRID.is_on_downbeat(9.0)

    def test_beat_index_is_none_outside_the_span(self):
        assert GRID.beat_index(-5.0) is None

    def test_nearest_beat_is_still_geometric(self):
        # The snap pass needs a target even slightly outside the span.
        assert GRID.nearest_beat(-2.0) == pytest.approx(0.0)

    def test_coverage_reports_the_measured_span(self):
        assert GRID.coverage == (0.0, 3.5)


class TestGeometry:
    def test_beats_between_is_half_open(self):
        assert GRID.beats_between(0.4, 1.6) == (0.5, 1.0, 1.5)

    def test_beats_between_excludes_the_endpoint(self):
        assert GRID.beats_between(0.0, 2.0) == (0.0, 0.5, 1.0, 1.5)

    def test_beats_between_empty_range(self):
        assert GRID.beats_between(2.0, 2.0) == ()

    def test_beat_index_locates_a_beat(self):
        assert GRID.beat_index(1.0) == 2

    def test_beat_index_is_none_off_the_beat(self):
        assert GRID.beat_index(1.25) is None

    def test_nearest_beat(self):
        assert GRID.nearest_beat(1.24) == pytest.approx(1.0)
        assert GRID.nearest_beat(1.26) == pytest.approx(1.5)

    def test_first_beat_ms_reports_the_phase(self):
        # The phase is what `t % beat_period` silently assumed to be zero.
        shifted = BeatGrid(bpm=120.0, beats=(0.123, 0.623), downbeats=(0.123,), confidence=0.9)
        assert shifted.first_beat_ms == 123

    def test_first_beat_ms_is_none_without_beats(self):
        assert empty_beat_grid().first_beat_ms is None


class TestSerialisation:
    def test_to_dict_shape(self):
        payload = GRID.to_dict()
        assert set(payload) == {
            "bpm", "beats", "downbeats", "firstBeatMs", "beatsPerBar", "confidence",
        }
        assert payload["bpm"] == 120.0
        assert payload["firstBeatMs"] == 0
        assert payload["beatsPerBar"] == 4
        assert payload["confidence"] == 0.9
        assert len(payload["beats"]) == 8

    def test_empty_grid_serialises_to_nulls(self):
        payload = empty_beat_grid().to_dict()
        assert payload["bpm"] is None
        assert payload["firstBeatMs"] is None
        assert payload["beats"] == []
        assert payload["confidence"] == 0.0


# --- tracking real audio ---------------------------------------------------


class TestTrackBeatGrid:
    def test_tracks_a_120_bpm_click_track(self):
        grid = track_beat_grid(click_track(120.0, 20.0))
        assert grid.has_grid
        assert grid.bpm == pytest.approx(120.0, abs=6.0)

    def test_detected_intervals_are_regular(self):
        # Accuracy on synthetic clicks is limited (librosa lands a few percent
        # off on impulsive input), but the interval sequence itself must be
        # consistent or the grid is not usable for snapping.
        grid = track_beat_grid(click_track(120.0, 20.0))
        intervals = np.diff(grid.beats)
        assert np.std(intervals) / np.mean(intervals) < 0.05

    def test_first_beats_land_on_the_clicks(self):
        # The tracker lands a few percent off on purely impulsive input, which
        # accumulates to tens of milliseconds within the first bars. That is
        # still far inside the 250 ms half-period, so the grid is plainly
        # aligned to the clicks rather than to the space between them.
        grid = track_beat_grid(click_track(120.0, 20.0))
        period = 0.5
        first = grid.beats[:4]
        offsets = [min(abs(b - round(b / period) * period), period / 2) for b in first]
        assert max(offsets) < 0.06

    def test_downbeats_are_a_subset_of_beats_spaced_a_bar_apart(self):
        grid = track_beat_grid(click_track(120.0, 20.0))
        assert grid.downbeats
        assert all(downbeat in grid.beats for downbeat in grid.downbeats)

        # Downbeats are every fourth beat *from a phase*, so the exact
        # invariant is the spacing between them, not a fixed count ratio.
        indices = [grid.beats.index(downbeat) for downbeat in grid.downbeats]
        assert all(later - earlier == 4 for earlier, later in zip(indices, indices[1:]))

    def test_tracker_starts_a_little_after_the_track_begins(self):
        # The grid does not span the whole track: the tracker needs a few
        # onsets before it commits. That is why coverage is reported.
        grid = track_beat_grid(click_track(120.0, 20.0))
        start, end = grid.coverage
        assert 0.0 <= start < 1.5
        assert end > 18.0

    def test_beats_cover_most_of_the_track(self):
        grid = track_beat_grid(click_track(120.0, 20.0))
        assert len(grid.beats) == pytest.approx(40, abs=6)

    def test_confidence_is_high_for_a_metronome(self):
        grid = track_beat_grid(click_track(120.0, 20.0))
        assert grid.confidence > 0.8

    def test_a_slow_but_musical_track_is_kept(self):
        grid = track_beat_grid(click_track(75.0, 20.0))
        assert grid.has_grid
        assert grid.bpm == pytest.approx(75.0, abs=6.0)

    def test_too_short_for_a_tempo(self):
        assert not track_beat_grid(np.zeros(8000, dtype=np.float32)).has_grid

    def test_empty_input(self):
        assert not track_beat_grid(np.zeros(0, dtype=np.float32)).has_grid

    def test_none_input(self):
        assert not track_beat_grid(None).has_grid

    def test_silence_yields_no_grid(self):
        # librosa finds no beats in digital silence, so the tempo gate is moot.
        assert not track_beat_grid(np.zeros(16000 * 10, dtype=np.float32)).has_grid


class TestTempoGate:
    """The musical-range gate, exercised directly.

    Testing it through audio would depend on which tempo the tracker latches
    onto: a 600 BPM click train is reported as ~85 or ~98 BPM, both inside the
    musical range, which is exactly the aliasing the gate cannot catch.
    """

    def test_a_tempo_in_range_keeps_its_regularity_score(self):
        beats = np.arange(0.0, 8.0, 0.5)
        assert _grid_confidence(beats, 120.0) > 0.9

    def test_a_tempo_above_the_range_is_rejected(self):
        beats = np.arange(0.0, 8.0, 0.1)
        assert _grid_confidence(beats, 600.0) == 0.0

    def test_a_tempo_below_the_range_is_rejected(self):
        beats = np.arange(0.0, 40.0, 2.0)
        assert _grid_confidence(beats, 30.0) == 0.0

    def test_irregular_intervals_lower_the_score(self):
        metronomic = np.arange(0.0, 8.0, 0.5)
        erratic = metronomic.copy()
        erratic[1::2] += 0.15
        assert _grid_confidence(erratic, 120.0) < _grid_confidence(metronomic, 120.0)

    def test_too_few_beats_is_rejected(self):
        assert _grid_confidence(np.array([0.0, 0.5, 1.0]), 120.0) == 0.0
