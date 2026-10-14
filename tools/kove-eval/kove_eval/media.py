"""Media IO for measurement: decode exactly the frames and samples we compare.

Every metric in this harness compares a reference against a rendered output at
the *same timestamps*. Both sides therefore have to be sampled the same way, or
the mismatch shows up as a colour or motion difference that is really a sampling
difference. The helpers here are the single place that decides how a timestamp
becomes a frame and how a time range becomes samples.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .ffmpeg import run_checked

# Decoding is not the measurement: 320px wide is enough to characterise colour
# and motion, and keeps a 30s clip's per-frame analysis in the seconds range.
ANALYSIS_WIDTH = 320

# Mixing/analysis rate for the harness's own audio work. 44.1k matches the
# generated tracks; `metrics` resamples to 16k only where a metric wants it.
MIX_SAMPLE_RATE = 44100


@dataclass(frozen=True)
class VideoInfo:
    path: str
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    sample_rate: int
    channels: int
    video_codec: str
    audio_codec: str


def probe(path: str | Path) -> VideoInfo:
    """Container and stream facts, via PyAV's demuxer."""
    import av

    with av.open(str(path)) as container:
        video = next((s for s in container.streams if s.type == "video"), None)
        audio = next((s for s in container.streams if s.type == "audio"), None)
        if video is None:
            raise ValueError(f"{path} has no video stream")

        if container.duration is not None:
            duration = float(container.duration) / 1_000_000.0
        else:
            duration = float(video.duration * video.time_base) if video.duration else 0.0

        fps = float(video.average_rate) if video.average_rate else 25.0
        return VideoInfo(
            path=str(path),
            duration=duration,
            width=int(video.codec_context.width),
            height=int(video.codec_context.height),
            fps=fps,
            has_audio=audio is not None,
            sample_rate=int(audio.codec_context.sample_rate) if audio else 0,
            channels=int(audio.codec_context.channels) if audio else 0,
            video_codec=video.codec_context.name,
            audio_codec=audio.codec_context.name if audio else "",
        )


class FrameReader:
    """Sequential decoder over one file.

    Seeking is only used when the requested timestamp is ahead of the cursor, so
    a sweep of evenly spaced timestamps decodes the file roughly once instead of
    seeking per frame — which on a long-GOP h264 export is the difference between
    seconds and minutes.
    """

    def __init__(self, path: str | Path, width: int = ANALYSIS_WIDTH) -> None:
        self.path = str(path)
        self.capture = cv2.VideoCapture(self.path)
        if not self.capture.isOpened():
            raise ValueError(f"could not open {self.path}")
        self.fps = self.capture.get(cv2.CAP_PROP_FPS) or 25.0
        self.scale_width = width
        self._cursor = -1  # last decoded frame index

    def close(self) -> None:
        self.capture.release()

    def __enter__(self) -> "FrameReader":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def frame_at(self, timestamp: float) -> np.ndarray | None:
        """BGR frame at `timestamp`, scaled to `scale_width`."""
        index = max(0, int(round(timestamp * self.fps)))
        if index < self._cursor:
            self.capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        elif index > self._cursor + 1:
            self.capture.set(cv2.CAP_PROP_POS_FRAMES, index)

        ok, frame = self.capture.read()
        if not ok or frame is None:
            return None
        self._cursor = index

        if self.scale_width and frame.shape[1] != self.scale_width:
            scale = self.scale_width / frame.shape[1]
            frame = cv2.resize(
                frame,
                (self.scale_width, max(1, int(round(frame.shape[0] * scale)))),
                interpolation=cv2.INTER_AREA,
            )
        return frame

    def frames_between(
        self, start: float, end: float, step: float
    ) -> list[tuple[float, np.ndarray]]:
        """Frames on a fixed grid in [start, end)."""
        out: list[tuple[float, np.ndarray]] = []
        t = start
        while t < end - 1e-9:
            frame = self.frame_at(t)
            if frame is None:
                break
            out.append((t, frame))
            t += step
        return out


def frames_at(path: str | Path, timestamps: list[float], width: int = ANALYSIS_WIDTH):
    """One list of (timestamp, BGR frame) for arbitrary timestamps."""
    out = []
    with FrameReader(path, width=width) as reader:
        for t in timestamps:
            frame = reader.frame_at(t)
            if frame is not None:
                out.append((t, frame))
    return out


def decode_audio(path: str | Path, sample_rate: int = 16000, mono: bool = True):
    """Decoded samples and their rate.

    PCM is decoded per-AVFrame and resampled once at the end rather than asking
    PyAV to resample frame-by-frame, so filter-warm-up artefacts do not appear at
    every frame boundary (which would read as loudness modulation).
    """
    import av

    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            return np.zeros(0, dtype=np.float32), sample_rate
        stream.thread_type = "AUTO"
        for frame in container.decode(stream):
            array = frame.to_ndarray()
            if array.ndim == 2 and array.shape[0] > 1:  # planar
                array = array.mean(axis=0)
            else:
                array = array.reshape(-1)
            chunks.append(np.asarray(array, dtype=np.float32))

    if not chunks:
        return np.zeros(0, dtype=np.float32), sample_rate

    samples = np.concatenate(chunks)
    rate = int(stream.codec_context.sample_rate or sample_rate)
    if mono and samples.ndim > 1:
        samples = samples.mean(axis=-1)
    if rate != sample_rate:
        try:
            import librosa

            samples = librosa.resample(samples, orig_sr=rate, target_sr=sample_rate)
        except Exception:  # pragma: no cover - librosa is a hard dependency
            ratio = sample_rate / rate
            index = np.arange(0, len(samples), 1.0 / ratio)
            samples = np.interp(index, np.arange(len(samples)), samples).astype(np.float32)
        rate = sample_rate
    return samples.astype(np.float32), rate


def write_video_from_frames(
    frames: list[np.ndarray],
    fps: float,
    out_path: str | Path,
    *,
    crf: int = 18,
    preset: str = "veryfast",
) -> None:
    """Encode BGR frames to h264 via ffmpeg's rawvideo pipe."""
    if not frames:
        raise ValueError("no frames to write")
    height, width = frames[0].shape[:2]
    import subprocess

    from .ffmpeg import ffmpeg_path

    argv = [
        ffmpeg_path(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{width}x{height}",
        "-r",
        f"{fps}",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-y",
        str(out_path),
    ]
    proc = subprocess.Popen(
        argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )
    assert proc.stdin is not None
    try:
        for frame in frames:
            proc.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
        proc.stdin.close()
    finally:
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        code = proc.wait()
    if code != 0:
        raise RuntimeError(f"ffmpeg frame pipe exited {code}\n{stderr[-2000:]}")


def write_wav(samples: np.ndarray, sample_rate: int, out_path: str | Path) -> None:
    """16-bit PCM wav through ffmpeg (no soundfile dependency at this layer)."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2").tobytes()
    import subprocess

    from .ffmpeg import ffmpeg_path

    argv = [
        ffmpeg_path(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "pcm_s16le",
        "-y",
        str(out_path),
    ]
    proc = subprocess.Popen(
        argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )
    assert proc.stdin is not None
    proc.stdin.write(pcm)
    proc.stdin.close()
    stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg wav write failed\n{stderr[-2000:]}")


def mux_audio_track(video_path: str | Path, audio_path: str | Path, out_path: str | Path) -> None:
    """Replace a file's audio with `audio_path` without re-encoding the video."""
    run_checked(
        [
            "-i",
            str(video_path),
            "-i",
            str(audio_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-y",
            str(out_path),
        ]
    )


def loudness_curve(path: str | Path, window: float = 0.4) -> tuple[np.ndarray, np.ndarray]:
    """(times, dBFS) short-term level curve.

    RMS in dBFS rather than LUFS: the loudness *shape* is what ducking and level
    matching are about, and ebur128's momentary values are a second apart, which
    is too coarse to see a duck that lasts half a beat. Integrated LUFS comes from
    ffmpeg's ebur128 (see `metrics.integrated_loudness`), where the standard's
    exact integration matters.
    """
    samples, rate = decode_audio(path, sample_rate=16000)
    if samples.size == 0:
        return np.zeros(0), np.zeros(0)
    hop = max(1, int(window * rate))
    count = max(1, len(samples) // hop)
    trimmed = samples[: count * hop].reshape(count, hop)
    rms = np.sqrt(np.mean(np.square(trimmed, dtype=np.float64), axis=1) + 1e-12)
    db = 20.0 * np.log10(np.maximum(rms, 1e-7))
    times = (np.arange(count) + 0.5) * window
    return times, db
