"""Test doubles for the GPU-only dependencies of the transcription service.

`faster_whisper` and `deep_translator` need a GPU and network access
respectively; the access-control and limit behaviour under test needs neither.
Installing stubs before `main` is imported keeps the tests runnable on a CPU box
(and in CI) while exercising the real request path: FastAPI routing, middleware,
the upload cap and the job lifecycle.
"""

import sys
import types
from dataclasses import dataclass, field


class FakeWord:
    def __init__(self, word: str, start: float, end: float) -> None:
        self.word = word
        self.start = start
        self.end = end


class FakeSegment:
    def __init__(self, text: str, words=None) -> None:
        self.text = text
        self.words = words if words is not None else []


class FakeInfo:
    def __init__(self, language: str = "en", duration: float = 1.0) -> None:
        self.language = language
        self.duration = duration


class FakeWhisperModel:
    """Stands in for `faster_whisper.WhisperModel`.

    `transcribe` returns a generator plus info, matching the real signature, so
    the service's own iteration code runs unchanged. Tests swap `behaviour` to
    provoke a failure or to hold a job open.
    """

    behaviour = "ok"

    def __init__(self, model_size, device=None, compute_type=None) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type

    def transcribe(self, path, **kwargs):
        if FakeWhisperModel.behaviour == "raise":
            raise RuntimeError(
                "CUDA out of memory at /srv/secret/path/model.bin — internal detail"
            )
        if FakeWhisperModel.behaviour == "hang":
            import time

            time.sleep(30)

        segments = [
            FakeSegment(
                " hello world",
                [
                    FakeWord("hello", 0.0, 0.4),
                    FakeWord("world", 0.4, 0.9),
                ],
            )
        ]
        return iter(segments), FakeInfo(duration=0.9)


class FakeGoogleTranslator:
    behaviour = "ok"

    def __init__(self, source=None, target=None) -> None:
        self.source = source
        self.target = target

    def translate(self, text):
        if FakeGoogleTranslator.behaviour == "raise":
            raise RuntimeError("upstream translator 500: internal detail")
        if text is None:
            return None
        return f"[{self.target}] {text}"


@dataclass
class _StubState:
    installed: list = field(default_factory=list)


def install() -> _StubState:
    state = _StubState()

    if "faster_whisper" not in sys.modules:
        module = types.ModuleType("faster_whisper")
        module.WhisperModel = FakeWhisperModel
        sys.modules["faster_whisper"] = module
        state.installed.append("faster_whisper")

    if "deep_translator" not in sys.modules:
        module = types.ModuleType("deep_translator")
        module.GoogleTranslator = FakeGoogleTranslator
        sys.modules["deep_translator"] = module
        state.installed.append("deep_translator")

    return state
