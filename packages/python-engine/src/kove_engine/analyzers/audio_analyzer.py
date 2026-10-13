from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from kove_engine.types import AudioResult

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
FRAME_DURATION_MS = 30

try:  # webrtcvad is a C extension; environments without Python build tools
    import webrtcvad  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised only where it is absent
    webrtcvad = None  # type: ignore[assignment]
    logger.warning("webrtcvad unavailable - VAD-based dialogue detection disabled")


class AudioAnalyzer:
    def __init__(
        self,
        silence_threshold_db: float = -40.0,
        silence_min_duration: float = 0.5,
        speech_ratio_threshold: float = 0.3,
        vad_aggressiveness: int = 3,
    ) -> None:
        self.silence_threshold_db = silence_threshold_db
        self.silence_min_duration = silence_min_duration
        self.speech_ratio_threshold = speech_ratio_threshold
        self.vad = None if webrtcvad is None else webrtcvad.Vad(vad_aggressiveness)

    def analyze(self, video_path: str, start: float, duration: float) -> AudioResult:
        """Analyze audio segment for silence, speech, and music."""
        audio = self._extract_audio_chunk(video_path, start, duration)
        if audio is None or len(audio) == 0:
            return AudioResult(
                has_dialogue=False, is_silence=True, has_music=False, bpm=None, rms_energy=0.0
            )

        rms_energy = self._compute_rms(audio)
        is_silence = self._detect_silence(audio)
        has_dialogue = False if is_silence else self._detect_speech_vad(audio)
        has_music, bpm = self._detect_music(audio)

        return AudioResult(
            has_dialogue=has_dialogue,
            is_silence=is_silence,
            has_music=has_music,
            bpm=bpm,
            rms_energy=rms_energy,
        )

    def _extract_audio_chunk(
        self, video_path: str, start: float, duration: float
    ) -> np.ndarray | None:
        """Extract audio chunk as float32 numpy array."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        cmd = [
            "ffmpeg", "-ss", str(start), "-t", str(duration),
            "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-y", tmp_path,
        ]
        try:
            subprocess.run(cmd, capture_output=True, check=True)
            with open(tmp_path, "rb") as f:
                f.read(44)  # Skip WAV header
                raw = f.read()
            return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            logger.warning("Failed to extract audio: %s", e)
            return None
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def _compute_rms(self, audio: np.ndarray) -> float:
        rms = np.sqrt(np.mean(audio**2))
        return float(min(rms * 5, 1.0))

    def _detect_silence(self, audio: np.ndarray) -> bool:
        frame_samples = int(SAMPLE_RATE * self.silence_min_duration)
        if len(audio) < frame_samples:
            frame_samples = len(audio)

        rms = np.sqrt(np.mean(audio[:frame_samples] ** 2))
        rms_db = 20 * np.log10(max(rms, 1e-10))
        return rms_db < self.silence_threshold_db

    def _detect_speech_vad(self, audio: np.ndarray) -> bool:
        if self.vad is None:
            return False
        frame_size = int(SAMPLE_RATE * FRAME_DURATION_MS / 1000)
        audio_bytes = (audio[: len(audio) - len(audio) % frame_size] * 32768).astype(
            np.int16
        ).tobytes()

        speech_frames = 0
        total_frames = 0

        for i in range(0, len(audio_bytes) - frame_size * 2, frame_size * 2):
            frame = audio_bytes[i : i + frame_size * 2]
            if len(frame) == frame_size * 2:
                total_frames += 1
                try:
                    if self.vad.is_speech(frame, SAMPLE_RATE):
                        speech_frames += 1
                except Exception:
                    continue

        if total_frames == 0:
            return False

        return (speech_frames / total_frames) > self.speech_ratio_threshold

    def detect_pauses(self, audio: np.ndarray) -> list[dict]:
        """Frame-level VAD pass: return silent gaps of at least
        ``silence_min_duration`` seconds as ``[{start, end}]`` inside this
        chunk (times relative to the chunk start).

        This is the pause data the editor snaps cut points with — it used to
        exist only as the ``is_silence`` boolean and never reached consumers.
        Without webrtcvad this returns an empty list rather than guessing.
        """
        if self.vad is None:
            return []

        frame_size = int(SAMPLE_RATE * FRAME_DURATION_MS / 1000)
        usable = audio[: len(audio) - len(audio) % frame_size]
        audio_bytes = (usable * 32768).astype(np.int16).tobytes()

        step = frame_size * 2
        min_gap_frames = int(self.silence_min_duration * 1000 / FRAME_DURATION_MS)
        pauses: list[dict] = []
        silent_run_start: int | None = None

        for i, offset in enumerate(range(0, len(audio_bytes) - step + 1, step)):
            frame = audio_bytes[offset : offset + step]
            is_speech = False
            try:
                is_speech = self.vad.is_speech(frame, SAMPLE_RATE)
            except Exception:  # noqa: BLE001 — a bad frame is silence evidence only
                is_speech = False
            if is_speech:
                if silent_run_start is not None and i - silent_run_start >= min_gap_frames:
                    pauses.append(
                        {
                            "start": silent_run_start * FRAME_DURATION_MS / 1000.0,
                            "end": i * FRAME_DURATION_MS / 1000.0,
                        }
                    )
                silent_run_start = None
            elif silent_run_start is None:
                silent_run_start = i

        if silent_run_start is not None:
            total_frames = len(audio_bytes) // step
            if total_frames - silent_run_start >= min_gap_frames:
                pauses.append(
                    {
                        "start": silent_run_start * FRAME_DURATION_MS / 1000.0,
                        "end": total_frames * FRAME_DURATION_MS / 1000.0,
                    }
                )
        return pauses

    def _detect_music(self, audio: np.ndarray) -> tuple[bool, float | None]:
        """Detect music via beat tracking. Returns (has_music, bpm)."""
        try:
            import librosa

            tempo, _ = librosa.beat.beat_track(y=audio, sr=SAMPLE_RATE)
            bpm = float(tempo) if hasattr(tempo, "__float__") else float(tempo[0])
            has_music = 60 < bpm < 200
            return has_music, bpm if has_music else None
        except Exception as e:
            logger.debug("Beat detection failed: %s", e)
            return False, None
