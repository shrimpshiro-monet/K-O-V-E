"""The render kernel: a timeline of clips in, an mp4 out.

WHY THIS EXISTS. The product's renderer is the browser compositor (WebGPU/WebCodecs
plus mediabunny), and it cannot run in this environment: there is no browser, and
Playwright's browser download is outside the network allowlist. A scorecard that
needs footage the pipeline rendered has to render *something*, so this module
renders the edit deterministically in Python.

WHAT THAT MEANS FOR EVERY NUMBER THE HARNESS PRODUCES. Anything scored off
`edl-python` output measures **the plan plus this renderer**, not the browser
engine. Where the plan and the renderer disagree about what was rendered, the
scorecard measures the disagreement (see `effects.py`'s rendered-vs-planned check),
so the craft gaps it reports are real gaps in a real render — but "the browser
engine renders this identically" is an assumption this harness cannot yet test.
That assumption is stated in every scorecard's provenance block.

The kernel deliberately renders the *whole* vocabulary the plan uses — cuts,
affine camera moves, parametric grade, caption overlays, transitions, audio mix
with ducking — because a renderer that silently drops a field would make the
"planned vs rendered" checks meaningless.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .media import (
    MIX_SAMPLE_RATE,
    FrameReader,
    mux_audio_track,
    write_video_from_frames,
    write_wav,
)

# --------------------------------------------------------------------------- #
# Timeline description
# --------------------------------------------------------------------------- #


@dataclass
class CameraMove:
    """A compiled camera move: scale ramps 1.0 → `1 + intensity` over a window.

    `easing` matters to how the move reads. A punch-in that eases out (fast then
    settling) reads as intentional; a linear one reads as a slow drift, and
    `easeOutBack` overshoots slightly, which is what a snap zoom does.
    """

    kind: str  # punch-in | punch-out | push-in | pull-out | snap-in | snap-out | shake
    start: float  # seconds into the clip
    duration: float
    intensity: float
    easing: str = "easeOutCubic"

    def scale_at(self, t: float) -> float:
        if t <= self.start:
            return 1.0
        if t >= self.start + self.duration:
            return 1.0 + self.intensity if "in" in self.kind else 1.0 - self.intensity
        progress = (t - self.start) / max(self.duration, 1e-6)
        eased = _ease(self.easing, progress)
        magnitude = self.intensity if "in" in self.kind else -self.intensity
        return 1.0 + magnitude * eased


def _ease(kind: str, p: float) -> float:
    p = min(max(p, 0.0), 1.0)
    if kind == "linear":
        return p
    if kind == "easeOutQuad":
        return 1 - (1 - p) ** 2
    if kind == "easeOutCubic":
        return 1 - (1 - p) ** 3
    if kind == "easeOutQuart":
        return 1 - (1 - p) ** 4
    if kind == "easeInOutSine":
        return -(math.cos(math.pi * p) - 1) / 2
    if kind == "easeOutBack":
        c1, c3 = 1.70158, 2.70158
        return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2
    if kind == "smoothstep":
        return p * p * (3 - 2 * p)
    return p


@dataclass
class Grade:
    """Parametric grade, applied in CIE-Lab.

    Lab rather than RGB because the plan's intent is perceptual ("lift the
    shadows", "warm the skin") and because step 2's LAB transfer is the same
    operation with the parameters measured from a reference instead of chosen.
    """

    l_offset: float = 0.0
    l_contrast: float = 1.0
    a_offset: float = 0.0
    b_offset: float = 0.0
    saturation: float = 1.0
    # Optional per-channel mean/std targets (LAB transfer). Set by step 2.
    transfer: dict[str, tuple[float, float]] | None = None

    def apply(self, bgr: np.ndarray) -> np.ndarray:
        if (
            self.l_offset == 0.0
            and self.l_contrast == 1.0
            and self.a_offset == 0.0
            and self.b_offset == 0.0
            and self.saturation == 1.0
            and self.transfer is None
        ):
            return bgr

        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
        lab[..., 0] = (lab[..., 0] - 128.0) * (255.0 / 100.0) + 128.0  # to 0..255 L scale

        if self.transfer is not None:
            for index, key in enumerate(("L", "a", "b")):
                target_mean, target_std = self.transfer[key]
                channel = lab[..., index]
                mean = float(channel.mean())
                std = float(channel.std()) or 1.0
                lab[..., index] = (channel - mean) / std * target_std + target_mean

        # L is 0..255 here; the plan's offsets are in perceptual Lab units (0..100).
        lab[..., 0] += self.l_offset * (255.0 / 100.0)
        lab[..., 0] = (lab[..., 0] - 128.0) * self.l_contrast + 128.0
        lab[..., 1] = (lab[..., 1] - 128.0) * self.saturation + 128.0 + self.a_offset
        lab[..., 2] = (lab[..., 2] - 128.0) * self.saturation + 128.0 + self.b_offset

        lab = np.clip(lab, 0, 255).astype(np.uint8)
        return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


@dataclass
class Caption:
    text: str
    start: float  # clip-relative seconds
    end: float
    style: str = "caption"  # caption | lower-third | title | callout
    position: str = "bottom"  # bottom | center | top
    font_size: int = 44
    color: str = "#FFFFFF"
    outline: str = "#000000"
    animate: bool = False


@dataclass
class Clip:
    """One segment on the timeline."""

    source: str  # path to the source file
    source_start: float
    source_end: float
    timeline_start: float
    pack_id: str = ""
    grade: Grade = field(default_factory=Grade)
    moves: list[CameraMove] = field(default_factory=list)
    captions: list[Caption] = field(default_factory=list)
    speed: float = 1.0
    # Transition into this clip from the previous one.
    transition_in: str = "cut"  # cut | dissolve | dip
    transition_duration: float = 0.4
    label: str = ""

    @property
    def duration(self) -> float:
        return (self.source_end - self.source_start) / max(self.speed, 1e-6)

    @property
    def timeline_end(self) -> float:
        return self.timeline_start + self.duration

    def source_time_at(self, timeline_time: float) -> float:
        return self.source_start + (timeline_time - self.timeline_start) * self.speed


@dataclass
class Timeline:
    clips: list[Clip]
    fps: float = 25.0
    size: tuple[int, int] = (1280, 720)  # width, height
    music: str = ""
    music_gain: float = 1.0
    voice: str = ""
    voice_gain: float = 0.0
    speech_windows: list[tuple[float, float]] = field(default_factory=list)
    duck_db: float = 0.0
    tail_seconds: float = 0.0

    @property
    def duration(self) -> float:
        if not self.clips:
            return 0.0
        return max(clip.timeline_end for clip in self.clips) + self.tail_seconds


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #

FONT_CANDIDATES = (
    "DejaVuSans-Bold.ttf",
    "DejaVuSans.ttf",
    "Arial.ttf",
)


def _font_path() -> str | None:
    """A real TTF, because PIL's bitmap default cannot scale and captions that
    cannot scale are not the captions the product renders."""
    try:
        import matplotlib

        fonts = Path(matplotlib.get_data_path()) / "fonts" / "ttf"
        for candidate in FONT_CANDIDATES:
            path = fonts / candidate
            if path.exists():
                return str(path)
    except Exception:
        pass
    for candidate in FONT_CANDIDATES:
        for root in ("/usr/share/fonts", "/usr/local/share/fonts"):
            root_path = Path(root)
            if not root_path.exists():
                continue
            for path in root_path.rglob(candidate):
                return str(path)
    return None


class _FontCache:
    def __init__(self) -> None:
        self.path = _font_path()
        self.cache: dict[int, object] = {}

    def get(self, size: int):
        from PIL import ImageFont

        if size not in self.cache:
            if self.path:
                self.cache[size] = ImageFont.truetype(self.path, size)
            else:  # pragma: no cover - only when no TTF exists at all
                self.cache[size] = ImageFont.load_default()
        return self.cache[size]


_FONTS = _FontCache()

CAPTION_STYLES = {
    # name: (size multiplier, colour, outline, y position, uppercase)
    "caption": (1.0, "#FFFFFF", "#000000", 0.86, False),
    "lower-third": (0.9, "#F2F2F2", "#101010", 0.78, False),
    "title": (1.6, "#FFFFFF", "#000000", 0.45, True),
    "callout": (1.1, "#FFE45C", "#000000", 0.30, True),
}


def _draw_text_overlay(
    frame_bgr: np.ndarray,
    text: str,
    style: str,
    position: str,
    font_size: int,
    color: str,
    outline: str,
    progress: float,
) -> None:
    """Draw one caption onto `frame_bgr` in place (BGR, uint8)."""
    from PIL import Image, ImageDraw

    size_scale, style_color, style_outline, y_fraction, uppercase = CAPTION_STYLES.get(
        style, CAPTION_STYLES["caption"]
    )
    if uppercase:
        text = text.upper()
    if position == "top":
        y_fraction = 0.12
    elif position == "center":
        y_fraction = 0.45

    image = Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(image)
    font = _FONTS.get(max(12, int(font_size * size_scale)))

    box = draw.textbbox((0, 0), text, font=font, stroke_width=2)
    text_width, text_height = box[2] - box[0], box[3] - box[1]
    x = (image.width - text_width) // 2
    y = int(image.height * y_fraction) - text_height // 2

    if progress < 0.25:
        # Entrance lift, so a caption does not simply appear.
        y += int(12 * (1 - progress / 0.25))

    draw.text(
        (x, y),
        text,
        font=font,
        fill=color or style_color,
        stroke_width=2,
        stroke_fill=outline or style_outline,
    )
    frame_bgr[:] = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def _apply_camera(frame_bgr: np.ndarray, scale: float) -> np.ndarray:
    """Scale about the frame centre, sub-pixel.

    `warpAffine` receives float offsets. Rounding them to integers — the obvious
    'optimisation' — is exactly the integer-pixel jitter that makes a slow push
    shimmer, so it is not done here and the test asserts the offsets stay
    fractional.
    """
    if abs(scale - 1.0) < 1e-6:
        return frame_bgr
    height, width = frame_bgr.shape[:2]
    centre_x, centre_y = width / 2.0, height / 2.0
    matrix = np.array(
        [[scale, 0.0, centre_x * (1.0 - scale)], [0.0, scale, centre_y * (1.0 - scale)]],
        dtype=np.float64,
    )
    return cv2.warpAffine(
        frame_bgr,
        matrix,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _dip_frame(height: int, width: int) -> np.ndarray:
    return np.zeros((height, width, 3), dtype=np.uint8)


def render_timeline(
    timeline: Timeline, out_path: Path, video_only_path: Path | None = None
) -> Path:
    """Render `timeline` to an h264 mp4 with a mixed audio track."""
    width, height = timeline.size
    fps = timeline.fps
    total_frames = max(1, int(round(timeline.duration * fps)))

    readers: dict[str, FrameReader] = {}
    for clip in timeline.clips:
        if clip.source not in readers:
            readers[clip.source] = FrameReader(clip.source, width=0)

    try:
        frames: list[np.ndarray] = []
        ordered = sorted(timeline.clips, key=lambda c: c.timeline_start)
        for index in range(total_frames):
            t = index / fps
            clip = _clip_at(ordered, t)
            if clip is None:
                frames.append(_dip_frame(height, width))
                continue

            reader = readers[clip.source]
            source_frame = reader.frame_at(clip.source_time_at(t))
            if source_frame is None:
                frames.append(_dip_frame(height, width))
                continue

            if source_frame.shape[0] != height or source_frame.shape[1] != width:
                source_frame = cv2.resize(
                    source_frame, (width, height), interpolation=cv2.INTER_AREA
                )

            local_t = t - clip.timeline_start
            scale = 1.0
            for move in clip.moves:
                scale *= move.scale_at(local_t)
            frame = _apply_camera(source_frame, scale)
            frame = clip.grade.apply(frame)

            previous, following = _neighbours(ordered, clip)
            frame = _blend_transition(frame, previous, following, clip, t, readers, timeline)

            for caption in clip.captions:
                if caption.start <= local_t < caption.end:
                    progress = (local_t - caption.start) / max(caption.end - caption.start, 1e-6)
                    _draw_text_overlay(
                        frame,
                        caption.text,
                        caption.style,
                        caption.position,
                        caption.font_size,
                        caption.color,
                        caption.outline,
                        progress,
                    )
            frames.append(frame)
    finally:
        for reader in readers.values():
            reader.close()

    video_target = video_only_path or out_path.with_suffix(".video.mp4")
    write_video_from_frames(frames, fps, video_target)

    if timeline.music or timeline.voice:
        audio_path = out_path.with_suffix(".audio.wav")
        _render_audio(timeline, audio_path, total_frames / fps)
        mux_audio_track(video_target, audio_path, out_path)
        audio_path.unlink(missing_ok=True)
    else:
        import shutil

        shutil.copyfile(video_target, out_path)
    if video_only_path is None:
        video_target.unlink(missing_ok=True)
    return out_path


def _clip_at(clips: list[Clip], t: float) -> Clip | None:
    for clip in clips:
        if clip.timeline_start <= t < clip.timeline_end:
            return clip
    return clips[-1] if clips and t >= clips[-1].timeline_end else None


def _neighbours(clips: list[Clip], clip: Clip) -> tuple[Clip | None, Clip | None]:
    index = clips.index(clip)
    previous = clips[index - 1] if index > 0 else None
    following = clips[index + 1] if index + 1 < len(clips) else None
    return previous, following


def _blend_transition(
    frame: np.ndarray,
    previous: Clip | None,
    following: Clip | None,
    clip: Clip,
    t: float,
    readers: dict[str, FrameReader],
    timeline: Timeline,
) -> np.ndarray:
    """Blend a dissolve or dip into `frame` where a transition covers `t`."""
    width, height = timeline.size

    if clip.transition_in in ("dissolve", "dip") and previous is not None:
        end = clip.timeline_start + clip.transition_duration / 2.0
        start = clip.timeline_start - clip.transition_duration / 2.0
        if start <= t < clip.timeline_start:
            progress = (t - start) / max(end - start, 1e-6)
            reader = readers[previous.source]
            source_t = previous.source_time_at(min(t, previous.timeline_end - 1e-3))
            other = reader.frame_at(max(previous.source_start, source_t))
            if other is not None:
                if other.shape[0] != height or other.shape[1] != width:
                    other = cv2.resize(other, (width, height), interpolation=cv2.INTER_AREA)
                other = previous.grade.apply(_apply_camera(other, 1.0))
                if clip.transition_in == "dip":
                    return _dip_blend(other, frame, progress)
                return cv2.addWeighted(other, 1.0 - progress, frame, progress, 0.0)

    if following is not None and following.transition_in in ("dissolve", "dip"):
        start = clip.timeline_end - following.transition_duration / 2.0
        end = clip.timeline_end + following.transition_duration / 2.0
        if start <= t < end:
            progress = (t - start) / max(end - start, 1e-6)
            reader = readers[following.source]
            other = reader.frame_at(following.source_time_at(max(t, following.timeline_start)))
            if other is not None:
                if other.shape[0] != height or other.shape[1] != width:
                    other = cv2.resize(other, (width, height), interpolation=cv2.INTER_AREA)
                other = following.grade.apply(_apply_camera(other, 1.0))
                if following.transition_in == "dip":
                    return _dip_blend(frame, other, progress)
                return cv2.addWeighted(frame, 1.0 - progress, other, progress, 0.0)
    return frame


def _dip_blend(a: np.ndarray, b: np.ndarray, progress: float) -> np.ndarray:
    """Through black: a fades out over the first half, b fades in over the second."""
    if progress < 0.5:
        factor = 1.0 - progress * 2.0
        return (a.astype(np.float32) * factor).astype(np.uint8)
    factor = (progress - 0.5) * 2.0
    return (b.astype(np.float32) * factor).astype(np.uint8)


def _render_audio(timeline: Timeline, out_path: Path, duration: float) -> None:
    """Mix music and voice with ducking, at the track's own sample rate."""
    from .media import decode_audio

    sample_rate = MIX_SAMPLE_RATE
    length = int(duration * sample_rate) + sample_rate
    mix = np.zeros(length, dtype=np.float32)

    if timeline.music:
        music, music_rate = decode_audio(timeline.music, sample_rate=sample_rate, mono=True)
        music = _fit(music, length)
        if timeline.speech_windows and timeline.duck_db:
            music = music * _duck_envelope(
                length, sample_rate, timeline.speech_windows, timeline.duck_db
            )
        mix += music * timeline.music_gain

    if timeline.voice and timeline.voice_gain:
        voice, _ = decode_audio(timeline.voice, sample_rate=sample_rate, mono=True)
        mix += _fit(voice, length) * timeline.voice_gain

    peak = float(np.max(np.abs(mix)) or 1.0)
    if peak > 0.98:
        mix = mix / peak * 0.98
    write_wav(mix[: int(duration * sample_rate)], sample_rate, out_path)


def _fit(samples: np.ndarray, length: int) -> np.ndarray:
    if samples.size >= length:
        return samples[:length]
    repeats = int(np.ceil(length / max(samples.size, 1)))
    return np.tile(samples, repeats)[:length]


def _duck_envelope(
    length: int, sample_rate: int, windows: list[tuple[float, float]], duck_db: float
) -> np.ndarray:
    """Gain envelope: `duck_db` down through each window, with real ramps.

    A hard gate would click and would also be a duck that no editor would make;
    120ms attack/release is both audible-as-intended and measurable.
    """
    gain = np.ones(length, dtype=np.float32)
    depth = 10.0 ** (-abs(duck_db) / 20.0)
    ramp = int(0.12 * sample_rate)
    for start, end in windows:
        a = max(0, int(start * sample_rate) - ramp)
        b = min(length, int(end * sample_rate) + ramp)
        if b <= a:
            continue
        segment = np.ones(b - a, dtype=np.float32) * depth
        attack = min(ramp, (b - a) // 2)
        release = min(ramp, (b - a) - attack)
        if attack > 0:
            segment[:attack] = np.linspace(1.0, depth, attack)
        if release > 0:
            segment[-release:] = np.linspace(depth, 1.0, release)
        gain[a:b] = np.minimum(gain[a:b], segment)
    return gain
