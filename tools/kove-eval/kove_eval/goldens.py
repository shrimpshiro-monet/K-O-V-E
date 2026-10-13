"""The craft golden set: 5 references, 3 footage packs, 3 tracks.

HONEST SCOPE — read this before quoting a number from it.

The references are **synthesised**, because this environment cannot fetch real
footage (the network allowlist is pypi/npm/github, and a real reference film is not
something to vendor into a repo anyway). What that buys and what it costs:

* Buys: every property the scorecard measures is present *by construction* and
  known exactly — cut times on a beat grid, a known grade in Lab, known zoom
  events with known magnitudes, known caption windows, known ducking windows. The
  scorecard is therefore validated against ground truth rather than against my
  opinion of what looks right, and `selftest` can check that each metric moves
  when the thing it measures is perturbed.
* Costs: the content is procedurally generated, so it does not contain the
  textures, faces, motion blur, compression history or grading of real footage.
  A metric that separates good from bad *here* has not been shown to separate them
  on a real shoot. Nothing in this file should be described as a real-world
  validation — it is a controlled fixture, and it is labelled as one everywhere it
  is reported.

The style families are chosen to differ in the properties the pipeline is supposed
to match (cut rate, beat density, grade, camera motion, caption load, audio
balance), not to imitate any particular brand or film.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

# --------------------------------------------------------------------------- #
# Procedural footage
# --------------------------------------------------------------------------- #

FRAME_SIZE = (1280, 720)
FPS = 25.0
# Sub-shots must be longer than the longest shot any family asks for (7.2s for
# cinematic-slow's 12 beats at 100 BPM). If they were shorter, a long shot would
# have to span two sub-shots and the boundary between them would be detected as a
# cut *inside* a shot — the reference would then not have the structure it claims.
SUB_SHOT_SECONDS = 8.0
SUB_SHOTS = 5
PACK_SECONDS = SUB_SHOT_SECONDS * SUB_SHOTS


@dataclass(frozen=True)
class PackSpec:
    id: str
    label: str
    kind: str  # canopy | city | portrait
    hue_base: int


PACKS = [
    PackSpec("canopy", "Green canopy, texture-rich, slow drift", "canopy", 60),
    PackSpec("city", "Blue-grey city, hard edges, moving traffic", "city", 110),
    PackSpec("portrait", "Skin-tone subject on pastel ground", "portrait", 20),
]


def _value_noise(height: int, width: int, scale: float, rng: np.random.Generator) -> np.ndarray:
    """Smooth 0..1 field: random low-res grid, bicubic up."""
    low_h = max(2, int(height / scale))
    low_w = max(2, int(width / scale))
    grid = rng.random((low_h, low_w)).astype(np.float32)
    return cv2.resize(grid, (width, height), interpolation=cv2.INTER_CUBIC)


def _canopy_frame(
    shot: int,
    local_t: float,
    rng: np.random.Generator,
    height: int,
    width: int,
) -> np.ndarray:
    """Layered leaf texture with parallax drift and moving light patches."""
    depth_shift = (shot * 37) % 100
    base = np.zeros((height, width), dtype=np.float32)
    layers = ((24.0, 0.5, 12.0), (12.0, 0.3, 22.0), (6.0, 0.2, 34.0))
    for layer, (scale, weight, speed) in enumerate(layers):
        field = _value_noise(height, width, scale, rng)
        shift_x = int((local_t * speed + depth_shift + layer * 13) % width)
        base += weight * np.roll(field, shift_x, axis=1)
    base = np.clip(base, 0, 1)

    hue_shift = (shot * 11) % 40
    bgr = np.zeros((height, width, 3), dtype=np.float32)
    bgr[..., 1] = 60 + 120 * base  # green
    bgr[..., 0] = 30 + 60 * (1 - base) + hue_shift
    bgr[..., 2] = 20 + 40 * base
    # light patches raking across the leaves
    light = np.clip(_value_noise(height, width, 30.0, rng) - 0.55, 0, 1) * 2.2
    bgr += light[..., None] * 90.0
    return np.clip(bgr, 0, 255).astype(np.uint8)


def _city_frame(
    shot: int,
    local_t: float,
    rng: np.random.Generator,
    height: int,
    width: int,
) -> np.ndarray:
    """Skyline silhouette with lit windows and traffic crossing the frame."""
    bgr = np.zeros((height, width, 3), dtype=np.float32)
    sky_top = 180 - (shot * 9) % 60
    gradient = np.linspace(sky_top, 90, height, dtype=np.float32)[:, None]
    bgr[..., 0] = gradient * 1.25  # blue-ish dusk
    bgr[..., 1] = gradient * 0.85
    bgr[..., 2] = gradient * 0.55

    horizon = int(height * (0.58 + 0.05 * ((shot % 3) - 1)))
    building_rng = np.random.default_rng(1000 + shot)
    x = 0
    while x < width:
        bw = int(building_rng.integers(40, 130))
        bh = int(building_rng.integers(60, int(height * 0.42)))
        top = horizon - bh
        bgr[top:horizon, x : x + bw] = np.array([34, 30, 26], dtype=np.float32)
        for wy in range(top + 8, horizon - 8, 18):
            for wx in range(x + 6, x + bw - 8, 16):
                if building_rng.random() < 0.45:
                    bgr[wy : wy + 7, wx : wx + 8] = np.array([120, 190, 210], dtype=np.float32)
        x += bw

    road = horizon + int(height * 0.22)
    cv2.rectangle(bgr, (0, road), (width, height), (28, 28, 32), -1)
    for lane, speed in ((0.0, 240.0), (0.5, 160.0)):
        car_x = int(((local_t * speed) + shot * 233) % (width + 200)) - 100
        y = int(road + lane * 34)
        cv2.rectangle(bgr, (car_x, y), (car_x + 52, y + 20), (40, 210, 245), -1)
        cv2.rectangle(bgr, (car_x + 40, y + 4), (car_x + 48, y + 12), (200, 240, 250), -1)
    return np.clip(bgr, 0, 255).astype(np.uint8)


def _portrait_frame(
    shot: int,
    local_t: float,
    rng: np.random.Generator,
    height: int,
    width: int,
) -> np.ndarray:
    """A skin-tone subject on a pastel background, drifting slightly.

    The subject exists so colour work has something to protect: the scorecard
    reports ΔE over all pixels *and* over non-skin pixels, and a grade that
    crushes skin tones shows up as a widening gap between the two.
    """
    background_hue = (shot * 23) % 180
    hsv = np.zeros((height, width, 3), dtype=np.uint8)
    hsv[..., 0] = background_hue
    hsv[..., 1] = 60
    hsv[..., 2] = 120 + 30 * math.sin(local_t * 0.5)
    bgr = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR).astype(np.float32)

    drift_x = int(10 * math.sin(local_t * 0.9 + shot))
    drift_y = int(6 * math.cos(local_t * 0.7 + shot))
    centre = (width // 2 + drift_x, int(height * 0.52) + drift_y)

    # shoulders, then the face, eyes, mouth, hair
    cv2.ellipse(bgr, (centre[0], centre[1] + 190), (150, 130), 0, 0, 360, (86, 96, 132), -1)
    cv2.ellipse(bgr, centre, (86, 108), 0, 0, 360, (128, 150, 205), -1)  # face
    cv2.ellipse(bgr, (centre[0] - 34, centre[1] - 14), (12, 8), 0, 0, 360, (60, 60, 70), -1)
    cv2.ellipse(bgr, (centre[0] + 34, centre[1] - 14), (12, 8), 0, 0, 360, (60, 60, 70), -1)
    cv2.ellipse(bgr, (centre[0], centre[1] + 38), (20, 9), 0, 0, 360, (92, 88, 150), -1)
    # hair, which is where a naive skin-tone mask leaks
    cv2.ellipse(bgr, (centre[0], centre[1] - 78), (80, 40), 0, 180, 360, (42, 46, 52), -1)

    grain = rng.normal(0.0, 3.0, size=(height, width, 1)).astype(np.float32)
    return np.clip(bgr + grain, 0, 255).astype(np.uint8)


_FRAME_FNS = {"canopy": _canopy_frame, "city": _city_frame, "portrait": _portrait_frame}


def pack_frame(pack: PackSpec, time_s: float, height: int = 720, width: int = 1280) -> np.ndarray:
    """One frame of a pack, addressed by absolute time (sub-shots in sequence)."""
    shot = min(SUB_SHOTS - 1, int(time_s // SUB_SHOT_SECONDS))
    local_t = time_s - shot * SUB_SHOT_SECONDS
    rng = np.random.default_rng(hash((pack.id, shot)) % (2**32))
    frame = _FRAME_FNS[pack.kind](shot, local_t, rng, height, width)
    return frame


def render_pack(pack: PackSpec, out_path: Path) -> Path:
    """Encode one pack: `PACK_SECONDS` of 720p25, sub-shot cuts included."""
    from .media import write_video_from_frames

    frames = []
    total = int(PACK_SECONDS * FPS)
    for index in range(total):
        frames.append(pack_frame(pack, index / FPS))
    write_video_from_frames(frames, FPS, out_path)
    return out_path


# --------------------------------------------------------------------------- #
# Music tracks and speech
# --------------------------------------------------------------------------- #

SAMPLE_RATE = 44100


@dataclass(frozen=True)
class TrackSpec:
    id: str
    bpm: float
    bars: int
    key_hz: float
    style: str  # pulse | warm | driving


TRACKS = [
    TrackSpec("pulse-140", 140.0, 16, 55.0, "pulse"),
    TrackSpec("warm-100", 100.0, 10, 65.4, "warm"),
    TrackSpec("driving-120", 120.0, 12, 49.0, "driving"),
]


@dataclass
class TrackGroundTruth:
    id: str
    bpm: float
    beats: list[float]
    downbeats: list[float]
    duration: float

    def as_dict(self) -> dict:
        return asdict(self)


def synth_track(spec: TrackSpec) -> tuple[np.ndarray, TrackGroundTruth]:
    """Kick + hat + sub-bass at a known tempo.

    The kick lands exactly on the beat, so the measured grid can be checked
    against the constructed one — which is how `selftest` proves the beat
    metric is reading the audio and not the file name.
    """
    beat = 60.0 / spec.bpm
    duration = spec.bars * 4 * beat
    samples = np.zeros(int(duration * SAMPLE_RATE) + SAMPLE_RATE, dtype=np.float32)
    t = np.arange(len(samples)) / SAMPLE_RATE

    beats = [round(i * beat, 4) for i in range(int(duration / beat))]
    for index, beat_time in enumerate(beats):
        start = int(beat_time * SAMPLE_RATE)
        length = int(0.18 * SAMPLE_RATE)
        env = np.exp(-np.arange(length) / (0.045 * SAMPLE_RATE)).astype(np.float32)
        frequency = 120.0 - 60.0 * (np.arange(length) / (length + 1))
        kick = env * np.sin(2 * np.pi * frequency * np.arange(length) / SAMPLE_RATE)
        samples[start : start + length] += 0.55 * kick.astype(np.float32)

        hat_start = int((beat_time + beat / 2) * SAMPLE_RATE)
        hat_length = int(0.05 * SAMPLE_RATE)
        hat_env = np.exp(-np.arange(hat_length) / (0.012 * SAMPLE_RATE)).astype(np.float32)
        hat = hat_env * np.random.default_rng(index).normal(0, 1, hat_length).astype(np.float32)
        samples[hat_start : hat_start + hat_length] += 0.10 * hat

    bass = 0.16 * np.sin(2 * np.pi * spec.key_hz * t).astype(np.float32)
    if spec.style == "driving":
        bass *= (0.6 + 0.4 * np.sin(2 * np.pi * (spec.bpm / 60.0 / 2.0) * t)).astype(np.float32)
    elif spec.style == "warm":
        bass = 0.10 * np.sin(2 * np.pi * (spec.key_hz * 2) * t).astype(np.float32)
    samples += bass

    if spec.style == "pulse":
        pad = 0.05 * np.sin(2 * np.pi * spec.key_hz * 3 * t).astype(np.float32)
        samples += pad

    peak = float(np.max(np.abs(samples)) or 1.0)
    samples = (samples / peak * 0.7).astype(np.float32)
    truth = TrackGroundTruth(
        id=spec.id,
        bpm=spec.bpm,
        beats=beats,
        downbeats=[b for i, b in enumerate(beats) if i % 4 == 0],
        duration=round(len(samples) / SAMPLE_RATE, 4),
    )
    return samples, truth


def synth_voice(duration: float, windows: list[tuple[float, float]], seed: int = 7) -> np.ndarray:
    """A speech-*band* signal during `windows`, silence elsewhere.

    Not speech — it is band-limited noise with a syllabic envelope, between 300
    and 3400 Hz, which is exactly what the ducking proxy needs: energy in the
    speech band, none in the low band, so the low band's level during these
    windows measures the music and nothing else.
    """
    rng = np.random.default_rng(seed)
    samples = np.zeros(int(duration * SAMPLE_RATE) + SAMPLE_RATE, dtype=np.float32)
    t = np.arange(len(samples)) / SAMPLE_RATE
    carrier = rng.normal(0, 1, len(samples)).astype(np.float32)
    carrier += 0.6 * np.sin(2 * np.pi * 420.0 * t).astype(np.float32)
    carrier += 0.4 * np.sin(2 * np.pi * 1150.0 * t).astype(np.float32)

    from scipy import signal as scipy_signal

    sos = scipy_signal.butter(
        4,
        [300.0 / (SAMPLE_RATE / 2), 3400.0 / (SAMPLE_RATE / 2)],
        btype="band",
        output="sos",
    )
    carrier = scipy_signal.sosfiltfilt(sos, carrier).astype(np.float32)

    envelope = np.zeros_like(carrier)
    for start, end in windows:
        a, b = int(start * SAMPLE_RATE), int(end * SAMPLE_RATE)
        length = max(1, b - a)
        syl = 0.5 + 0.5 * np.sin(2 * np.pi * 4.5 * (np.arange(length) / SAMPLE_RATE))
        envelope[a:b] = syl * 0.9
    samples += carrier * envelope
    peak = float(np.max(np.abs(samples)) or 1.0)
    return (samples / peak * 0.5).astype(np.float32)


# --------------------------------------------------------------------------- #
# Reference families
# --------------------------------------------------------------------------- #


@dataclass
class FamilySpec:
    id: str
    label: str
    track: str
    cut_beats: list[float]  # shot lengths in beats, cycled
    zoom: str  # none | punch | push | snap
    zoom_intensity: float
    caption_density: float  # captions per shot, 0 = none
    grade: dict[str, float]  # lab_l / lab_a / lab_b offsets, saturation, contrast
    transitions: dict[str, float]  # cut / dissolve / dip weights
    speech: bool
    duck_db: float
    music_gain: float
    voice_gain: float
    size: tuple[int, int] = FRAME_SIZE


FAMILIES = [
    FamilySpec(
        id="pulse-fast",
        label="Fast beat-locked cutting, warm punchy grade, punch-ins on the beat",
        track="pulse-140",
        cut_beats=[2, 2, 1, 2, 1, 2, 2, 1],
        zoom="punch",
        zoom_intensity=0.16,
        caption_density=0.5,
        grade={"lab_l": 4.0, "lab_a": 9.0, "lab_b": 6.0, "saturation": 1.28, "contrast": 1.12},
        transitions={"cut": 0.85, "dissolve": 0.1, "dip": 0.05},
        speech=False,
        duck_db=0.0,
        music_gain=1.0,
        voice_gain=0.0,
    ),
    FamilySpec(
        id="cinematic-slow",
        label="Long takes, slow push, teal-orange split tone, no captions",
        track="warm-100",
        cut_beats=[8, 8, 12, 8, 8],
        zoom="push",
        zoom_intensity=0.07,
        caption_density=0.0,
        grade={"lab_l": -6.0, "lab_a": 4.0, "lab_b": -7.0, "saturation": 0.92, "contrast": 1.18},
        transitions={"cut": 0.6, "dissolve": 0.3, "dip": 0.1},
        speech=False,
        duck_db=0.0,
        music_gain=0.9,
        voice_gain=0.0,
    ),
    FamilySpec(
        id="doc-natural",
        label="Natural colour, speech under a light bed, dusted with captions",
        track="driving-120",
        cut_beats=[4, 6, 4, 8, 4, 6],
        zoom="none",
        zoom_intensity=0.0,
        caption_density=0.25,
        grade={"lab_l": 1.5, "lab_a": 0.0, "lab_b": 0.0, "saturation": 1.0, "contrast": 1.02},
        transitions={"cut": 0.95, "dissolve": 0.05, "dip": 0.0},
        speech=True,
        duck_db=11.0,
        music_gain=0.35,
        voice_gain=0.5,
    ),
    FamilySpec(
        id="social-vertical",
        label="Vertical, one-beat cuts, snap zooms, heavy caption load",
        track="pulse-140",
        cut_beats=[1, 1, 2, 1, 1, 1, 2],
        zoom="snap",
        zoom_intensity=0.22,
        caption_density=1.0,
        grade={"lab_l": 3.0, "lab_a": 6.0, "lab_b": -3.0, "saturation": 1.35, "contrast": 1.2},
        transitions={"cut": 1.0, "dissolve": 0.0, "dip": 0.0},
        speech=True,
        duck_db=8.0,
        music_gain=0.55,
        voice_gain=0.45,
        size=(720, 1280),
    ),
    FamilySpec(
        id="text-forward",
        label="Bright flat grade, caption-led, medium cuts",
        track="warm-100",
        cut_beats=[2, 3, 2, 4, 3, 2],
        zoom="push",
        zoom_intensity=0.05,
        caption_density=0.8,
        grade={"lab_l": 9.0, "lab_a": -2.0, "lab_b": 3.0, "saturation": 1.06, "contrast": 0.96},
        transitions={"cut": 0.75, "dissolve": 0.25, "dip": 0.0},
        speech=True,
        duck_db=6.0,
        music_gain=0.45,
        voice_gain=0.4,
    ),
]


@dataclass
class ReferenceGroundTruth:
    """What the generator built, exactly. The scorecard never reads this to
    score against — it re-measures everything from pixels — but `selftest` uses
    it to check that the analysers recover the construction."""

    id: str
    label: str
    pack_ids: list[str] = field(default_factory=list)
    track_id: str = ""
    bpm: float = 0.0
    beats: list[float] = field(default_factory=list)
    cuts: list[float] = field(default_factory=list)
    shot_lengths_beats: list[float] = field(default_factory=list)
    motion_events: list[dict] = field(default_factory=list)
    caption_windows: list[list[float]] = field(default_factory=list)
    speech_windows: list[list[float]] = field(default_factory=list)
    transitions: list[dict] = field(default_factory=list)
    duck_db: float = 0.0
    grade: dict[str, float] = field(default_factory=dict)
    duration: float = 0.0
    size: list[int] = field(default_factory=list)
    video: str = ""
    music: str = ""

    def as_dict(self) -> dict:
        payload = asdict(self)
        payload.pop("family", None)
        return payload
