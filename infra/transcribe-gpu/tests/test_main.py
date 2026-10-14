"""Access-control and limit tests for the GPU transcription service.

The service shipped with no authentication at all while `setup.sh` starts it on
a cloud GPU host with `8000:8000` published, no cap on upload size (the whole
body was read into memory), no bound on concurrent jobs, and `str(exception)`
returned to the client. These tests describe the behaviour that replaced it.
"""

import asyncio
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from stubs import FakeGoogleTranslator, FakeWhisperModel

import main

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
AUDIO = ("clip.wav", b"RIFF....WAVEfmt ", "audio/wav")


def post(client, **kwargs):
    kwargs.setdefault("headers", AUTH)
    return client.post("/transcribe", files={"audio": AUDIO}, **kwargs)


def wait_for_terminal(client, job_id, timeout=10.0):
    """Poll a job until it leaves `processing`, the way the client does."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if payload["status"] != "processing":
            return payload
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached a terminal state")


class TestAuthorization:
    def test_without_a_configured_token_the_service_refuses_to_serve(
        self, monkeypatch
    ):
        """Fail closed: an unconfigured GPU endpoint must not run open."""
        monkeypatch.delenv("KOVE_TRANSCRIBE_TOKEN", raising=False)
        with TestClient(main.app) as client:
            response = post(client, headers={})

        assert response.status_code == 503
        assert "KOVE_TRANSCRIBE_TOKEN" in response.json()["detail"]

    def test_a_blank_token_is_treated_as_unset(self, monkeypatch):
        monkeypatch.setenv("KOVE_TRANSCRIBE_TOKEN", "   ")
        with TestClient(main.app) as client:
            response = post(client, headers={})

        assert response.status_code == 503

    def test_a_request_with_no_token_is_refused(self):
        with TestClient(main.app) as client:
            response = post(client, headers={})

        assert response.status_code == 401

    def test_a_request_with_the_wrong_token_is_refused(self):
        with TestClient(main.app) as client:
            response = post(client, headers={"Authorization": "Bearer nope"})

        assert response.status_code == 401

    def test_a_request_with_the_token_is_accepted(self):
        with TestClient(main.app) as client:
            response = post(client)

            assert response.status_code == 200
            job_id = response.json()["jobId"]
            assert len(job_id) >= 32  # uuid4, not a guessable counter
            wait_for_terminal(client, job_id)

    def test_health_stays_open_so_a_probe_can_see_the_service(self, monkeypatch):
        monkeypatch.delenv("KOVE_TRANSCRIBE_TOKEN", raising=False)
        with TestClient(main.app) as client:
            response = client.get("/health")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        # The probe tells an operator whether the lockdown is active.
        assert body["authenticated"] is False

    def test_job_results_are_not_readable_without_the_token(self):
        with TestClient(main.app) as client:
            job_id = post(client).json()["jobId"]

            assert client.get(f"/jobs/{job_id}").status_code == 401
            assert client.get(f"/jobs/{job_id}", headers=AUTH).status_code == 200
            wait_for_terminal(client, job_id)

    def test_the_root_alias_is_protected_too(self):
        with TestClient(main.app) as client:
            response = client.post("/", files={"audio": AUDIO})

        assert response.status_code == 401


class TestUploadCap:
    def test_an_oversized_body_is_refused_before_the_handler_runs(self):
        """Starlette spools the body to disk before the handler, so the cap has
        to live in middleware — a handler-only check fires after the write."""
        app = main.create_app(upload_limit=64)
        with TestClient(app) as client:
            response = client.post(
                "/transcribe",
                files={"audio": ("big.wav", b"x" * 5000, "audio/wav")},
                headers=AUTH,
            )

        assert response.status_code == 413
        assert "upload_too_large" in response.text

    def test_the_shipped_app_carries_the_cap(self):
        limits = [
            entry.kwargs.get("limit")
            for entry in main.app.user_middleware
            if entry.cls is main.BodySizeLimitMiddleware
        ]
        assert limits == [main.MAX_UPLOAD_BYTES]

    def test_the_streaming_cap_fires_and_leaves_no_temp_file(self, monkeypatch, tmp_path):
        """The counting path, for a body with no usable Content-Length."""
        monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 10)
        monkeypatch.setattr(main, "UPLOAD_CHUNK_BYTES", 4)
        monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))

        class ChunkedUpload:
            filename = "clip.wav"

            def __init__(self):
                self.chunks = [b"aaaa", b"bbbb", b"cccc", b"dddd"]

            async def read(self, _size):
                return self.chunks.pop(0) if self.chunks else b""

        with pytest.raises(HTTPException) as caught:
            asyncio.run(main._store_upload(ChunkedUpload()))

        assert caught.value.status_code == 413
        # The partial file must not be left behind on the GPU host's disk.
        assert list(tmp_path.iterdir()) == []


class TestJobLimits:
    def test_a_full_queue_is_refused_rather_than_queued(self, monkeypatch):
        monkeypatch.setattr(main, "MAX_CONCURRENT_JOBS", 1)
        with TestClient(main.app) as client:
            main.active_jobs = 1  # the one slot a single-job host has
            response = post(client)

        assert response.status_code == 429
        assert response.headers["Retry-After"] == "10"

    def test_a_completed_job_releases_its_slot(self):
        with TestClient(main.app) as client:
            job_id = post(client).json()["jobId"]
            wait_for_terminal(client, job_id)

        assert main.active_jobs == 0

    def test_a_failed_job_releases_its_slot(self):
        FakeWhisperModel.behaviour = "raise"
        with TestClient(main.app) as client:
            job_id = post(client).json()["jobId"]
            wait_for_terminal(client, job_id)

        assert main.active_jobs == 0


class TestFailureReporting:
    def test_a_failed_job_does_not_leak_the_exception(self):
        FakeWhisperModel.behaviour = "raise"
        with TestClient(main.app) as client:
            job_id = post(client).json()["jobId"]
            payload = wait_for_terminal(client, job_id)

        assert payload["status"] == "failed"
        assert payload["error"] == main.GENERIC_JOB_FAILURE
        body = str(payload)
        assert "CUDA out of memory" not in body
        assert "/srv/secret/path" not in body

    def test_a_failed_translation_still_returns_the_transcript(self):
        FakeGoogleTranslator.behaviour = "raise"
        try:
            with TestClient(main.app) as client:
                job_id = client.post(
                    "/transcribe",
                    files={"audio": AUDIO},
                    data={"target_language": "fr"},
                    headers=AUTH,
                ).json()["jobId"]
                payload = wait_for_terminal(client, job_id)
        finally:
            FakeGoogleTranslator.behaviour = "ok"

        assert payload["status"] == "completed"
        assert "hello world" in payload["result"]["text"]


class TestHappyPath:
    def test_a_transcript_comes_back_with_words_and_language(self):
        with TestClient(main.app) as client:
            job_id = post(client).json()["jobId"]
            payload = wait_for_terminal(client, job_id)

        assert payload["status"] == "completed"
        result = payload["result"]
        assert result["text"] == "hello world"
        assert result["word_count"] == 2
        assert result["words"][0] == {"word": "hello", "start": 0.0, "end": 0.4}
        assert result["language"] == "en"

    def test_translation_to_english_uses_the_model(self):
        with TestClient(main.app) as client:
            job_id = client.post(
                "/transcribe",
                files={"audio": AUDIO},
                data={"language": "de", "target_language": "en"},
                headers=AUTH,
            ).json()["jobId"]
            payload = wait_for_terminal(client, job_id)

        assert payload["status"] == "completed"


class TestTempFileHygiene:
    @pytest.mark.parametrize(
        "filename,expected",
        [
            ("clip.mp4", ".mp4"),
            ("CLIP.MOV", ".mov"),
            ("../../etc/passwd", ""),
            ("no-extension", ""),
            ("evil.sh", ".sh"),
            ("archive.tar.gz", ".gz"),
        ],
    )
    def test_the_temp_suffix_is_derived_safely(self, filename, expected):
        suffix = main._safe_suffix(filename)
        assert "/" not in suffix and "\\" not in suffix
        assert suffix == (expected or ".wav")

    def test_a_traversal_filename_does_not_break_the_job(self):
        with TestClient(main.app) as client:
            response = client.post(
                "/transcribe",
                files={"audio": ("../../../../tmp/evil.wav", b"RIFF", "audio/wav")},
                headers=AUTH,
            )
            assert response.status_code == 200
            wait_for_terminal(client, response.json()["jobId"])
