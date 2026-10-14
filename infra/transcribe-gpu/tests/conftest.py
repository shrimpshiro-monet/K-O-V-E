"""Make the service importable and stub its GPU-only dependencies.

The stubs must be in place *before* `main` is imported, which is why this runs at
conftest import time rather than inside a fixture.
"""

import sys
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stubs import FakeWhisperModel, install  # noqa: E402

install()


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """Every test starts with an empty job table and a working model."""
    import main

    monkeypatch.setenv("KOVE_TRANSCRIBE_TOKEN", "test-token")
    FakeWhisperModel.behaviour = "ok"
    main.jobs.clear()
    main.active_jobs = 0
    yield
    main.jobs.clear()
    main.active_jobs = 0
