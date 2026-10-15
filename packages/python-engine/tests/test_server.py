"""HTTP surface: the job contract shared by /analyze-frames and /analyze-upload."""

import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import server
from kove_engine.types import SegmentMap, VideoSegmentMap


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A client whose jobs DB lives in tmp_path and whose schema is created."""
    monkeypatch.setattr(server.job_store, "path", str(tmp_path / "jobs.db"))
    # The lifespan hook (and therefore job_store.init) only runs inside the
    # context manager — without it every job write hits "no such table".
    with TestClient(server.app) as test_client:
        yield test_client


def test_analyze_frames_accepts_empty_batches(client):
    response = client.post(
        "/analyze-frames",
        json={"videoId": "clip", "totalDuration": 0, "frames": []},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"

    job = client.get(f"/jobs/{response.json()['jobId']}").json()
    assert job["status"] == "completed"
    assert job["result"]["totalFrames"] == 0
    assert job["result"]["batches"] == [{"batchIndex": 0, "descriptions": []}]


def _fake_orchestrator(report: dict) -> MagicMock:
    orchestrator = MagicMock()
    orchestrator.analyze_with_report.return_value = (
        SegmentMap(videos=[
            VideoSegmentMap(video_id=report["videoId"], duration=4.0, segments=[]),
        ]),
        report,
    )
    return orchestrator


def test_analyze_upload_completes_with_pinned_id_and_role(client):
    report = {
        "analysisVersion": "1.2.0",
        "videoId": "reference-1",
        "duration": 4.0,
        "summary": {"cutCount": 2, "pacing": "fast"},
        "styleProfile": {"cutsPerMinute": 30.0, "medianShotDuration": 2.0},
        "editPattern": {"cutEvidence": [{"time": 0.0, "confidence": 0.9}]},
    }
    with patch.object(server, "Orchestrator", return_value=_fake_orchestrator(report)):
        response = client.post(
            "/analyze-upload",
            data={"video_id": "reference-1", "role": "reference"},
            files={"file": ("clip.mp4", b"not-a-real-video", "video/mp4")},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["jobId"]

    job = client.get(f"/jobs/{payload['jobId']}").json()
    assert job["status"] == "completed"
    result = job["result"]
    assert result["referenceAnalysis"]["analysisVersion"] == "1.2.0"
    assert result["referenceAnalysis"]["videos"][0]["videoId"] == "reference-1"
    assert result["referenceAnalysis"]["videos"][0]["role"] == "reference"


def test_analyze_upload_defaults_role_to_source(client):
    report = {"analysisVersion": "1.2.0", "videoId": "source-1"}
    with patch.object(server, "Orchestrator", return_value=_fake_orchestrator(report)):
        response = client.post(
            "/analyze-upload",
            data={"video_id": "source-1"},
            files={"file": ("clip.mp4", b"bytes", "video/mp4")},
        )

    job = client.get(f"/jobs/{response.json()['jobId']}").json()
    assert job["result"]["referenceAnalysis"]["videos"][0]["role"] == "source"


def test_analyze_upload_records_a_failure_instead_of_hanging(client):
    orchestrator = MagicMock()
    orchestrator.analyze_with_report.side_effect = RuntimeError("decoder exploded")
    with patch.object(server, "Orchestrator", return_value=orchestrator):
        response = client.post(
            "/analyze-upload",
            data={"video_id": "broken"},
            files={"file": ("clip.mp4", b"bytes", "video/mp4")},
        )

    job = client.get(f"/jobs/{response.json()['jobId']}").json()
    assert job["status"] == "failed"
    assert "decoder exploded" in job["result"]["error"]


def test_analyze_upload_sweeps_expired_jobs(client):
    server.job_store  # fixture already pointed the store at tmp_path
    import asyncio

    async def seed_stale_job() -> None:
        await server.job_store.init()
        await server.job_store.create("stale", {}, now=time.time() - 7200)

    asyncio.run(seed_stale_job())
    assert client.get("/jobs/stale").json()["status"] == "pending"

    report = {"analysisVersion": "1.2.0", "videoId": "reference-2"}
    with patch.object(server, "Orchestrator", return_value=_fake_orchestrator(report)):
        client.post(
            "/analyze-upload",
            data={"video_id": "reference-2"},
            files={"file": ("clip.mp4", b"bytes", "video/mp4")},
        )

    assert client.get("/jobs/stale").json()["status"] == "unknown"
