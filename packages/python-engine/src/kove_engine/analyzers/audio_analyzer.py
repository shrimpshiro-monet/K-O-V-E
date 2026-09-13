from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import webrtcvad

from kove_engine.types import AudioResult

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
FRAME_DURATION_MS = 30


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
        self.vad = webrtcvad.Vad(vad_aggressiveness)

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
