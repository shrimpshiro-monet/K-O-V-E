"""Beat and downbeat tracking over a whole audio track.

The engine used to derive "beats" from the timestamps of sampled frames that
happened to contain music, and to estimate BPM from one-second audio chunks.
Neither is a beat. A sample timestamp says when we looked, not when the music
pulsed, and a one-second window is far too short to establish a tempo, so the
per-chunk BPM values that were averaged together were noise.

This module tracks the music once, over its full length, and returns the actual
beat and downbeat positions plus a confidence. Everything downstream -- cut
alignment, effect placement, the reference style profile -- measures against
these times instead of against a period assumption.

Known limitation
----------------
A tracker cannot tell a real pulse from a plausible one. Measured on synthetic
input, the obvious "are the beats landing on energy?" checks do not separate
the two cases: a pure noise signal scores higher on onset coverage (0.75) than
genuinely musical audio (0.33-0.41), because noise puts peaks everywhere. So
there is deliberately no salience gate here -- one would reject real music to
catch a rare artifact.

What *is* enforced is that the tempo is musical (60-200 BPM), that enough beats
were found, and that `confidence` reports how regular the intervals are. A grid
can therefore still be found in material with no real pulse (ambient, speech
over a drone). Callers should treat `confidence` as the reliability signal and
fall back to onsets or user-tapped beats when it is low, as the playbook
directs. Upgrading to a model-based tracker (Beat This!, which does not assume
a fixed tempo) is the real fix; it needs a torch dependency.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000

#: The playbook's on-beat tolerance. Two frames at 60 fps, and tight enough
#: that a random cut rarely lands inside it by chance.
BEAT_TOLERANCE_SECONDS = 0.04

#: Tempo range treated as musical. Outside this the "grid" is usually an
#: artifact of noise, speech, or a half/double-time detection error.
MIN_BPM = 60.0
MAX_BPM = 200.0

#: Fewer beats than this is not enough to establish a grid or a downbeat phase.
MIN_BEATS_FOR_GRID = 4


@dataclass(frozen=True)
class BeatGrid:
    """Measured beat positions for one track, in seconds from track start."""

    bpm: float | None
    beats: tuple[float, ...]
    downbeats: tuple[float, ...]
    confidence: float
    beats_per_bar: int = 4

    @property
    def has_grid(self) -> bool:
        return self.bpm is not None and len(self.beats) >= MIN_BEATS_FOR_GRID

    @property
    def first_beat_ms(self) -> int | None:
        """Offset of the first beat, in milliseconds.

        This is the phase of the grid: without it, a `t % beat_period`
        calculation silently assumes a beat lands exactly on t=0.
        """
        if not self.beats:
            return None
        return int(round(self.beats[0] * 1000))

    @property
    def coverage(self) -> tuple[float, float] | None:
        """The span the beats were actually measured over, in seconds."""
        if not self.beats:
            return None
        return (self.beats[0], self.beats[-1])

    @property
    def period_s(self) -> float | None:
        if not self.bpm:
            return None
        return 60.0 / self.bpm

    def is_covered(self, timestamp: float) -> bool:
        """Whether `timestamp` is close enough to measured beats to be judged.

        A tracker typically starts emitting beats a little after the track
        begins, and intros are frequently beatless. Timestamps outside the
        measured span get `None` rather than a large offset, so they are
        excluded from on-beat statistics instead of counted as misses.
        """
        coverage = self.coverage
        if coverage is None:
            return False
        margin = self.period_s or 0.0
        return (coverage[0] - margin) <= timestamp <= (coverage[1] + margin)

    def nearest_beat(self, timestamp: float) -> float | None:
        """The closest measured beat, regardless of coverage.

        Pure geometry, used by the snap pass to find a target. Use
        `offset_ms` when the question is whether a time *is* on a beat.
        """
        if not self.beats:
            return None
        beats = np.asarray(self.beats)
        index = int(np.argmin(np.abs(beats - timestamp)))
        return float(beats[index])

    def offset_ms(self, timestamp: float) -> float | None:
        """Signed offset from `timestamp` to the nearest beat, in ms.

        Negative means the timestamp lands *before* the beat, which is where
        editors habitually place cuts: the visual change then reads as
        landing on the beat. None when the timestamp is outside the measured
        grid.
        """
        if not self.is_covered(timestamp):
            return None
        beat = self.nearest_beat(timestamp)
        if beat is None:
            return None
        return (timestamp - beat) * 1000.0

    def is_on_beat(self, timestamp: float, tolerance_s: float = BEAT_TOLERANCE_SECONDS) -> bool:
        offset = self.offset_ms(timestamp)
        return offset is not None and abs(offset) <= tolerance_s * 1000.0

    def is_on_downbeat(
        self, timestamp: float, tolerance_s: float = BEAT_TOLERANCE_SECONDS
    ) -> bool:
        offset = self.downbeat_offset_ms(timestamp)
        return offset is not None and abs(offset) <= tolerance_s * 1000.0

    def downbeat_offset_ms(self, timestamp: float) -> float | None:
        if not self.downbeats or not self.is_covered(timestamp):
            return None
        downbeats = np.asarray(self.downbeats)
        index = int(np.argmin(np.abs(downbeats - timestamp)))
        return float((timestamp - float(downbeats[index])) * 1000.0)

    def beats_between(self, start: float, end: float) -> tuple[float, ...]:
        """Beats inside [start, end)."""
        if not self.beats or end <= start:
            return ()
        beats = np.asarray(self.beats)
        mask = (beats >= start) & (beats < end)
        return tuple(float(value) for value in beats[mask])

    def beat_index(self, timestamp: float, tolerance_s: float = BEAT_TOLERANCE_SECONDS) -> int | None:
        """Index of the beat this timestamp sits on, if any.

        Used to decide whether a cut lands on a bar line or a subdivision.
        """
        if not self.is_covered(timestamp):
            return None
        offset = self.offset_ms(timestamp)
        if offset is None or abs(offset) > tolerance_s * 1000.0:
            return None
        beats = np.asarray(self.beats)
        return int(np.argmin(np.abs(beats - timestamp)))

    def to_dict(self) -> dict:
        """The wire shape stored in referenceAnalysis."""
        return {
            "bpm": round(self.bpm, 1) if self.bpm is not None else None,
            "beats": [round(beat, 4) for beat in self.beats],
            "downbeats": [round(beat, 4) for beat in self.downbeats],
            "firstBeatMs": self.first_beat_ms,
            "beatsPerBar": self.beats_per_bar,
            "confidence": round(self.confidence, 3),
        }


def empty_beat_grid(beats_per_bar: int = 4) -> BeatGrid:
    return BeatGrid(
        bpm=None, beats=(), downbeats=(), confidence=0.0, beats_per_bar=beats_per_bar
    )


def _downbeat_phase(
    beat_times: np.ndarray,
    onset_envelope: np.ndarray,
    sr: int,
    beats_per_bar: int,
) -> int:
    """Pick the bar phase whose beats carry the most onset energy.

    Downbeat tracking proper needs a model; this is the cheap version that is
    right most of the time on 4/4 material, which is what short-form edits use.
    The confidence reported alongside lets callers distrust it.
    """
    if len(beat_times) < beats_per_bar or len(onset_envelope) == 0:
        return 0

    frames = np.clip(
        np.round(np.asarray(beat_times) * sr / 512.0).astype(int),
        0,
        len(onset_envelope) - 1,
    )
    strength = np.asarray(onset_envelope)[frames]

    best_phase = 0
    best_score = -np.inf
    for phase in range(beats_per_bar):
        score = float(np.sum(strength[phase::beats_per_bar]))
        if score > best_score:
            best_score = score
            best_phase = phase
    return best_phase


def _grid_confidence(beat_times: np.ndarray, tempo: float) -> float:
    """Confidence in [0, 1] from tempo plausibility and interval regularity."""
    if len(beat_times) < MIN_BEATS_FOR_GRID:
        return 0.0
    if not (MIN_BPM <= tempo <= MAX_BPM):
        return 0.0

    intervals = np.diff(beat_times)
    mean_interval = float(np.mean(intervals))
    if mean_interval <= 0:
        return 0.0

    # Coefficient of variation: 0 is perfectly metronomic.
    variation = float(np.std(intervals) / mean_interval)
    regularity = max(0.0, 1.0 - variation * 2.0)
    return float(min(1.0, regularity))


def track_beat_grid(
    samples: np.ndarray,
    sr: int = SAMPLE_RATE,
    beats_per_bar: int = 4,
) -> BeatGrid:
    """Track beats and downbeats across `samples`.

    Returns an empty grid (never raises) when the material has no usable
    pulse: ambient music, drifting tempo, or mostly speech.
    """
    if samples is None or len(samples) < sr:  # under a second cannot hold a tempo
        return empty_beat_grid(beats_per_bar)

    try:
        import librosa
    except Exception as e:  # pragma: no cover - librosa is a hard dependency
        logger.warning("librosa unavailable, skipping beat tracking: %s", e)
        return empty_beat_grid(beats_per_bar)

    try:
        audio = np.asarray(samples, dtype=np.float32)

        # A fixed hop keeps frame<->time conversion exact for the onset envelope.
        hop_length = 512
        onset_envelope = librosa.onset.onset_strength(
            y=audio, sr=sr, hop_length=hop_length
        )

        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_envelope, sr=sr, hop_length=hop_length, units="frames"
        )
        tempo_value = float(np.atleast_1d(tempo)[0])
        beat_times = librosa.frames_to_time(
            np.atleast_1d(beat_frames), sr=sr, hop_length=hop_length
        )

        if len(beat_times) < MIN_BEATS_FOR_GRID:
            return empty_beat_grid(beats_per_bar)

        confidence = _grid_confidence(beat_times, tempo_value)
        if confidence <= 0.0:
            return empty_beat_grid(beats_per_bar)

        phase = _downbeat_phase(beat_times, onset_envelope, sr, beats_per_bar)
        downbeats = beat_times[phase::beats_per_bar]

        return BeatGrid(
            bpm=tempo_value,
            beats=tuple(float(value) for value in beat_times),
            downbeats=tuple(float(value) for value in downbeats),
            confidence=confidence,
            beats_per_bar=beats_per_bar,
        )
    except Exception as e:
        logger.warning("Beat tracking failed: %s", e)
        return empty_beat_grid(beats_per_bar)


def extract_audio_track(video_path: str, sr: int = SAMPLE_RATE) -> np.ndarray | None:
    """Decode a file's full audio track to mono float32.

    Beat tracking needs the whole track: tempo is a property of the piece, not
    of any one-second window inside it.
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    cmd = [
        "ffmpeg", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", str(sr), "-ac", "1",
        "-y", tmp_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True)
        with open(tmp_path, "rb") as handle:
            handle.read(44)  # skip WAV header
            raw = handle.read()
        if not raw:
            return None
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        logger.warning("Failed to extract full audio track: %s", e)
        return None
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def track_beat_grid_for_file(
    video_path: str, sr: int = SAMPLE_RATE, beats_per_bar: int = 4
) -> BeatGrid:
    """Convenience wrapper: decode the file's audio, then track it."""
    samples = extract_audio_track(video_path, sr=sr)
    if samples is None:
        return empty_beat_grid(beats_per_bar)
    return track_beat_grid(samples, sr=sr, beats_per_bar=beats_per_bar)
