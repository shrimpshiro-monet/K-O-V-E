import subprocess
from unittest.mock import patch

import numpy as np

from kove_engine.analyzers.audio_analyzer import AudioAnalyzer
from kove_engine.types import AudioResult


def test_silence_detection():
    analyzer = AudioAnalyzer()
    with patch.object(analyzer, "_extract_audio_chunk") as mock_extract:
        mock_extract.return_value = np.zeros(16000, dtype=np.float32)
        result = analyzer.analyze("/fake/video.mp4", 0.0, 1.0)
    assert result.is_silence is True
    assert result.rms_energy < 0.01


def test_speech_detection():
    analyzer = AudioAnalyzer()
    with patch.object(analyzer, "_extract_audio_chunk") as mock_extract:
        t = np.linspace(0, 1, 16000, dtype=np.float32)
        speech_signal = np.sin(2 * np.pi * 300 * t) * 0.5
        mock_extract.return_value = speech_signal
        with patch.object(analyzer, "_detect_speech_vad") as mock_vad:
            mock_vad.return_value = True
            result = analyzer.analyze("/fake/video.mp4", 0.0, 1.0)
    assert result.has_dialogue is True


def test_no_audio_returns_silence():
    analyzer = AudioAnalyzer()
    with patch("subprocess.run") as mock_run:
        mock_run.side_effect = subprocess.CalledProcessError(1, "ffmpeg")
        result = analyzer.analyze("/fake/video.mp4", 0.0, 1.0)
    assert result.is_silence is True
    assert result.has_dialogue is False
    assert result.has_music is False


def test_audio_result_structure():
    analyzer = AudioAnalyzer()
    with patch.object(analyzer, "_extract_audio_chunk") as mock_extract:
        mock_extract.return_value = np.random.randn(16000).astype(np.float32) * 0.1
        with patch.object(analyzer, "_detect_speech_vad") as mock_vad:
            mock_vad.return_value = False
            with patch.object(analyzer, "_detect_music") as mock_music:
                mock_music.return_value = (False, None)
                result = analyzer.analyze("/fake/video.mp4", 0.0, 1.0)
    assert isinstance(result, AudioResult)
    assert 0.0 <= result.rms_energy <= 1.0
