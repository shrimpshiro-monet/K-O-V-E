"""ASR for K-O-V-E — faster-whisper with word timestamps.

Sandbox/Mac split: the faster-whisper MODEL is downloaded from Hugging Face at
first run, which is impossible in the Arena sandbox (no HF egress). The code
is written and unit-tested against an injected fake model; the USER runs the
real model on their Mac (``pip install -e ".[asr]"`` inside the venv, then
restart terminal A).

Decisions already made (reversible, no design doc needed):
- engine: faster-whisper, word timestamps on
- model: ``KOVE_WHISPER_MODEL`` (default ``small``), compute ``KOVE_WHISPER_COMPUTE_TYPE``
  (default ``int8``) on ``KOVE_WHISPER_DEVICE`` (default ``cpu``) — the Mac runs this on CPU
- diarization: optional pyannote behind ``KOVE_DIARIZE=1``; best-effort —
  transcription ships even where diarization can't
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from pydantic import BaseModel

from kove_engine.analyzers.audio_analyzer import SAMPLE_RATE, AudioAnalyzer

logger = logging.getLogger(__name__)

# Env is read per-Transcriber (not at import) so a changed KOVE_WHISPER_MODEL
# applies to the next job without restarting the server.
DEFAULT_WHISPER_MODEL = "small"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_DEVICE = "cpu"


class TranscribeWord(BaseModel):
    word: str
    start: float
    end: float


class TranscribeSegment(BaseModel):
    start: float
    end: float
    text: str
    words: list[TranscribeWord]
    speaker: str | None = None


class Pause(BaseModel):
    start: float
    end: float


class TranscriptionResult(BaseModel):
    videoPath: str
    start: float
    duration: float
    language: str | None = None
    model: str
    diarized: bool
    segments: list[TranscribeSegment]
    """Silent gaps (VAD) inside the transcribed window, relative to `start`.
    This data existed in the engine for a long time but never reached any
    consumer — it rides along here so cut policies can snap to it."""
    pauses: list[Pause]
    processingTimeMs: int


class Transcriber:
    """Word-timestamped transcription with pass-through pause/VAD analysis.

    ``model_loader`` is injectable for tests: it receives (model_size,
    compute_type, device) and must return an object with a ``transcribe``
    method matching faster-whisper's (yields segment objects with ``start``,
    ``end``, ``text``, ``words``). production loader is lazy — faster-whisper
    imports only when a job actually runs, so environments without it can
    still serve every other endpoint.
    """

    def __init__(
        self,
        model_size: str | None = None,
        compute_type: str | None = None,
        device: str | None = None,
        model_loader=None,
        vad_pause_min_duration: float = 0.4,
    ) -> None:
        self.model_size = model_size or os.environ.get("KOVE_WHISPER_MODEL", DEFAULT_WHISPER_MODEL)
        self.compute_type = compute_type or os.environ.get("KOVE_WHISPER_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)
        self.device = device or os.environ.get("KOVE_WHISPER_DEVICE", DEFAULT_DEVICE)
        self._model_loader = model_loader or self._load_faster_whisper_model
        self._model = None
        self._audio = AudioAnalyzer(silence_min_duration=vad_pause_min_duration)

    # -- model handling ------------------------------------------------------

    _shared_model = None
    _shared_model_key: tuple[str, str, str] | None = None

    @classmethod
    def _load_faster_whisper_model(cls, model_size: str, compute_type: str, device: str):
        key = (model_size, compute_type, device)
        if cls._shared_model is not None and cls._shared_model_key == key:
            return cls._shared_model
        from faster_whisper import WhisperModel  # lazy: heavy, optional

        logger.info("loading whisper model %s (%s/%s)", model_size, compute_type, device)
        cls._shared_model = WhisperModel(model_size, device=device, compute_type=compute_type)
        cls._shared_model_key = key
        return cls._shared_model

    def _ensure_model(self):
        if self._model is None:
            self._model = self._model_loader(self.model_size, self.compute_type, self.device)
        return self._model

    # -- audio ---------------------------------------------------------------

    def _extract_audio(self, video_path: str, start: float, duration: float | None) -> str:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", str(start),
        ]
        if duration is not None:
            cmd += ["-t", str(duration)]
        cmd += [
            "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-y", tmp_path,
        ]
        try:
            subprocess.run(cmd, capture_output=True, check=True)
        except subprocess.CalledProcessError as exc:
            raise ValueError(f"ffmpeg audio extraction failed: {exc.stderr.decode(errors='replace')[:300]}") from exc
        return tmp_path

    @staticmethod
    def _load_wav(path: str) -> np.ndarray:
        """Read the extracted 16 kHz mono s16le wav back as float32."""
        import wave

        with wave.open(path, "rb") as wav:
            frames = wav.getnframes()
            raw = wav.readframes(frames)
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    # -- diarization (optional, best-effort) ----------------------------------

    @staticmethod
    def _diarize_segments(audio_path: str) -> list[dict] | None:
        """Return [{start, end, speaker}] or None when unavailable."""
        if os.environ.get("KOVE_DIARIZE") != "1":
            return None
        try:
            from pyannote.audio import Pipeline  # lazy, optional, needs HF token

            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=os.environ.get("HUGGINGFACE_TOKEN"),
            )
            diarization = pipeline(audio_path)
            return [
                {"start": turn.start, "end": turn.end, "speaker": label}
                for turn, _, label in diarization.itertracks(yield_label=True)
            ]
        except Exception as exc:  # noqa: BLE001 — diarization must never kill transcription
            logger.warning("diarization unavailable, shipping unlabeled segments: %s", exc)
            return None

    @staticmethod
    def _attach_speakers(segments: list[TranscribeSegment], speaker_turns: list[dict] | None) -> list[TranscribeSegment]:
        if not speaker_turns:
            return segments
        out: list[TranscribeSegment] = []
        for segment in segments:
            speaker = None
            best_overlap = 0.0
            for turn in speaker_turns:
                overlap = min(segment.end, turn["end"]) - max(segment.start, turn["start"])
                if overlap > best_overlap:
                    best_overlap = overlap
                    speaker = turn["speaker"]
            out.append(segment.model_copy(update={"speaker": speaker}))
        return out

    # -- main entry ------------------------------------------------------------

    def transcribe(self, video_path: str, start: float = 0.0, duration: float | None = None) -> TranscriptionResult:
        import time

        started = time.monotonic()
        if not Path(video_path).exists():
            raise ValueError(f"video not found: {video_path}")

        audio_path = self._extract_audio(video_path, start, duration)
        try:
            # Pause/VAD pass on the SAME extracted audio — pass-through of the
            # analysis that already existed here, now reaching consumers.
            try:
                audio = self._load_wav(audio_path)
            except Exception:  # noqa: BLE001 — pauses are additive, never fatal
                audio = None
            pauses_raw = self._audio.detect_pauses(audio) if audio is not None else []

            model = self._ensure_model()
            segments_iter, info = model.transcribe(audio_path, word_timestamps=True)
            speaker_turns = self._diarize_segments(audio_path)

            segments: list[TranscribeSegment] = []
            for seg in segments_iter:
                words = [
                    TranscribeWord(word=word.word.strip(), start=float(word.start), end=float(word.end))
                    for word in (seg.words or [])
                    if word.start is not None and word.end is not None
                ]
                segments.append(
                    TranscribeSegment(
                        start=float(seg.start),
                        end=float(seg.end),
                        text=(seg.text or "").strip(),
                        words=words,
                    )
                )

            segments = self._attach_speakers(segments, speaker_turns)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            return TranscriptionResult(
                videoPath=video_path,
                start=start,
                duration=duration if duration is not None else float(info.duration or 0.0),
                language=getattr(info, "language", None),
                model=self.model_size,
                diarized=speaker_turns is not None,
                segments=segments,
                pauses=[Pause(**p) for p in pauses_raw],
                processingTimeMs=elapsed_ms,
            )
        finally:
            try:
                os.unlink(audio_path)
            except OSError:
                pass
