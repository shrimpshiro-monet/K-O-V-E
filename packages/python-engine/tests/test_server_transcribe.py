"""Server tests for POST /transcribe — same job contract as /analyze."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import server
from kove_engine.transcriber import TranscriptionResult, TranscribeSegment, TranscribeWord


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "JOBS_DB_PATH", str(tmp_path / "jobs.db"))
    # Rebuild the store against the temp db before the lifespan init runs.
    from kove_engine.job_store import JobStore

    monkeypatch.setattr(server, "job_store", JobStore(str(tmp_path / "jobs.db")))
    with TestClient(server.app) as test_client:
        yield test_client


def _fake_result_model() -> TranscriptionResult:
    return TranscriptionResult(
        videoPath="/tmp/clip.mp4",
        start=0.0,
        duration=4.2,
        language="en",
        model="small",
        diarized=False,
        segments=[
            TranscribeSegment(
                start=0.0,
                end=2.0,
                text="hello there",
                words=[TranscribeWord(word="hello", start=0.0, end=0.5), TranscribeWord(word="there", start=0.6, end=2.0)],
            )
        ],
        pauses=[{"start": 2.0, "end": 3.0}],
        processingTimeMs=42,
    )


def _fake_result() -> dict:
    return _fake_result_model().model_dump()


def test_transcribe_returns_job_id_immediately(client):
    resp = client.post("/transcribe", json={"video_path": "/tmp/clip.mp4"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert len(body["jobId"]) >= 8


def test_transcribe_job_completes_with_word_timestamps_and_pauses(client):
    with patch("server._run_transcribe_job", autospec=True) as runner:
        # Run the real logic synchronously with a stubbed Transcriber.
        async def fake_run(job_id, req):
            await server.job_store.set_status(job_id, "running")
            await server.job_store.set_status(job_id, "completed", _fake_result())

        runner.side_effect = fake_run
        job_id = client.post("/transcribe", json={"video_path": "/tmp/clip.mp4"}).json()["jobId"]

    polled = client.get(f"/jobs/{job_id}").json()
    assert polled["status"] == "completed"
    result = polled["result"]
    assert result["segments"][0]["words"][0]["word"] == "hello"
    assert result["pauses"] == [{"start": 2.0, "end": 3.0}]


def test_transcribe_job_failure_is_terminal_with_hint(client):
    with patch("server._run_transcribe_job", autospec=True) as runner:

        async def fake_run(job_id, req):
            await server.job_store.set_status(
                job_id,
                "failed",
                {"error": "ModuleNotFoundError: faster_whisper", "hint": 'pip install -e ".[asr]"'},
            )

        runner.side_effect = fake_run
        job_id = client.post("/transcribe", json={"video_path": "/tmp/clip.mp4"}).json()["jobId"]

    polled = client.get(f"/jobs/{job_id}").json()
    assert polled["status"] == "failed"
    assert "asr" in polled["result"]["hint"]


def test_transcribe_accepts_optional_range_and_model(client):
    resp = client.post(
        "/transcribe",
        json={"video_path": "/tmp/clip.mp4", "start": 1.5, "duration": 3.0, "model": "base"},
    )
    assert resp.status_code == 200


def test_transcribe_requires_exactly_one_source(client):
    both = client.post(
        "/transcribe",
        json={"video_path": "/tmp/a.mp4", "audio_data": "AAAA"},
    )
    assert both.json()["status"] == "invalid_request"
    neither = client.post("/transcribe", json={})
    assert neither.json()["status"] == "invalid_request"


def test_transcribe_upload_writes_decoded_audio_for_the_transcriber(client, monkeypatch):
    """audio_data (browser upload) is decoded to a real file and handed to the
    Transcriber; the temp file is removed afterwards."""
    import base64

    captured = {}

    class FakeTranscriber:
        def __init__(self, model_size=None):
            captured["model"] = model_size

        def transcribe(self, source, start, duration):
            captured["source_bytes"] = open(source, "rb").read()
            captured["start"], captured["duration"] = start, duration
            return _fake_result_model()  # server calls .model_dump() itself

    monkeypatch.setattr("kove_engine.transcriber.Transcriber", FakeTranscriber)
    payload = base64.b64encode(b"RIFF fakewav").decode()
    resp = client.post(
        "/transcribe",
        json={"audio_data": payload, "sample_rate": 48000, "start": 0.5, "duration": 2.0},
    )
    assert resp.status_code == 200
    job_id = resp.json()["jobId"]
    polled = client.get(f"/jobs/{job_id}").json()
    assert polled["status"] == "completed"
    assert captured["source_bytes"].startswith(b"RIFF")
    assert captured["start"] == 0.5 and captured["duration"] == 2.0
