"""Transcriber tests — the whisper model is FAKE (injected model_loader).

No network, no Hugging Face: the real model downloads at first use on the
user's machine; here we prove the plumbing (word timestamps, pause
pass-through, diarization attachment, error paths) with a scripted model.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field

import numpy as np
import pytest

from kove_engine.transcriber import Transcriber, TranscriptionResult


@dataclass
class FakeWord:
    word: str
    start: float
    end: float


@dataclass
class FakeSegment:
    start: float
    end: float
    text: str
    words: list[FakeWord] = field(default_factory=list)


@dataclass
class FakeInfo:
    duration: float = 12.0
    language: str | None = "en"


class FakeWhisperModel:
    """Scripted faster-whisper stand-in: returns two segments with words."""

    def __init__(self, segments=None, fail=False):
        self.segments = segments if segments is not None else [
            FakeSegment(0.0, 2.4, " We went for it.", [
                FakeWord("We", 0.0, 0.2),
                FakeWord("went", 0.3, 0.6),
                FakeWord("for", 0.7, 0.9),
                FakeWord("it.", 1.0, 2.4),
            ]),
            FakeSegment(2.8, 5.1, " Then we rested.", [
                FakeWord("Then", 2.8, 3.0),
                FakeWord("we", 3.1, 3.2),
                FakeWord("rested.", 3.3, 5.1),
            ]),
        ]
        self.fail = fail
        self.calls = []

    def transcribe(self, audio_path, word_timestamps=False):
        self.calls.append({"audio_path": audio_path, "word_timestamps": word_timestamps})
        if self.fail:
            raise RuntimeError("model exploded")
        return iter(self.segments), FakeInfo()


@pytest.fixture
def tiny_wav_video(tmp_path, monkeypatch):
    """A 'video' that is really a 2 s 16 kHz wav — ffmpeg copies/decodes it fine
    for our extraction (pcm_s16le mono), no real video needed."""
    import wave

    path = tmp_path / "clip.wav"
    sr = 16000
    # 0.4 s tone, 0.6 s silence, 0.5 s tone, tail silence ≥ 0.4 s
    tone = 0.35 * np.sin(2 * np.pi * 440 * np.arange(sr * 2) / sr)
    envelope = np.zeros(sr * 2)
    envelope[: int(0.4 * sr)] = 1
    envelope[int(1.0 * sr) : int(1.5 * sr)] = 1
    samples = (tone * envelope * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        wav.writeframes(samples.tobytes())
    monkeypatch.setattr(Transcriber, "_extract_audio", lambda self, vp, start, duration: str(path))
    return path


def make_transcriber(model=None, **kwargs) -> Transcriber:
    return Transcriber(
        model_loader=lambda size, compute, device: model or FakeWhisperModel(),
        vad_pause_min_duration=0.4,
        **kwargs,
    )


class RmsFakeVad:
    """Deterministic VAD stand-in: speech iff frame RMS exceeds a threshold.

    webrtcvad is a C extension that can't build in environments without
    Python headers; this fake keeps the pause-assembly logic (run detection,
    gap boundaries, tail handling) under test everywhere.
    """

    def __init__(self, threshold: float = 0.05) -> None:
        self.threshold = threshold

    def is_speech(self, frame_bytes: bytes, sample_rate: int) -> bool:
        samples = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        return bool(np.sqrt(np.mean(samples**2)) > self.threshold)


def test_transcribe_returns_word_timestamped_segments(tiny_wav_video):
    result = make_transcriber().transcribe(str(tiny_wav_video))
    assert isinstance(result, TranscriptionResult)
    assert len(result.segments) == 2
    first = result.segments[0]
    assert first.text == "We went for it."
    assert [w.word for w in first.words] == ["We", "went", "for", "it."]
    assert first.words[0].start == pytest.approx(0.0)
    assert result.language == "en"
    assert result.model  # reports which model produced it


def test_transcribe_includes_vad_pauses_for_the_window(tiny_wav_video):
    transcriber = make_transcriber()
    # Real webrtcvad when it built; deterministic RMS fake everywhere else.
    if transcriber._audio.vad is None:
        transcriber._audio.vad = RmsFakeVad()
    result = transcriber.transcribe(str(tiny_wav_video))
    # 0.4-1.0 s silence ≥ min 0.4 s pause, and the ≥0.5 s tail.
    assert len(result.pauses) >= 1
    starts = [round(p.start, 2) for p in result.pauses]
    assert any(abs(s - 0.4) < 0.15 or abs(s - 1.5) < 0.15 for s in starts)


def test_pauses_are_empty_without_any_vad(tiny_wav_video):
    transcriber = make_transcriber()
    transcriber._audio.vad = None  # webrtcvad-free environment
    result = transcriber.transcribe(str(tiny_wav_video))
    assert result.pauses == []


def test_transcribe_attaches_speakers_when_diarization_available(tiny_wav_video, monkeypatch):
    monkeypatch.setenv("KOVE_DIARIZE", "1")
    monkeypatch.setattr(
        Transcriber,
        "_diarize_segments",
        staticmethod(lambda audio_path: [{"start": 2.7, "end": 5.2, "speaker": "SPEAKER_1"}]),
    )
    result = make_transcriber().transcribe(str(tiny_wav_video))
    assert result.diarized is True
    assert result.segments[0].speaker is None  # outside the turn
    assert result.segments[1].speaker == "SPEAKER_1"  # overlaps the turn


def test_diarization_off_by_default(tiny_wav_video, monkeypatch):
    monkeypatch.delenv("KOVE_DIARIZE", raising=False)
    result = make_transcriber().transcribe(str(tiny_wav_video))
    assert result.diarized is False
    assert all(seg.speaker is None for seg in result.segments)


def test_model_failure_raises_and_job_layer_can_map_it(tiny_wav_video):
    with pytest.raises(RuntimeError, match="model exploded"):
        make_transcriber(FakeWhisperModel(fail=True)).transcribe(str(tiny_wav_video))


def test_missing_video_is_a_value_error(tmp_path):
    transcriber = make_transcriber()
    with pytest.raises(ValueError, match="video not found"):
        transcriber.transcribe(str(tmp_path / "nope.mp4"))


def test_extraction_failure_bubbles_a_value_error(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "ffmpeg", stderr=b"no audio stream")

    monkeypatch.setattr("kove_engine.transcriber.subprocess.run", boom)
    real_file = tmp_path / "real.mp4"
    real_file.write_bytes(b"\x00\x00")
    with pytest.raises(ValueError, match="ffmpeg audio extraction failed"):
        make_transcriber().transcribe(str(real_file))


def test_model_loader_receives_env_config(monkeypatch):
    monkeypatch.setenv("KOVE_WHISPER_MODEL", "medium")
    monkeypatch.setenv("KOVE_WHISPER_COMPUTE_TYPE", "int8")
    monkeypatch.setenv("KOVE_WHISPER_DEVICE", "cpu")
    seen = {}

    def loader(size, compute, device):
        seen.update({"size": size, "compute": compute, "device": device})
        return FakeWhisperModel()

    Transcriber(model_loader=loader)._ensure_model()
    assert seen == {"size": "medium", "compute": "int8", "device": "cpu"}


def test_segment_without_words_yields_empty_word_list(tiny_wav_video):
    model = FakeWhisperModel(segments=[FakeSegment(0.0, 1.0, " plain")])
    result = make_transcriber(model).transcribe(str(tiny_wav_video))
    assert result.segments[0].words == []
    assert result.segments[0].text == "plain"
