"""Contract and access-control tests for the local analysis server.

`/analyze` used to accept any path the process could read, serve anyone who
could reach the port, hand out 32-bit job ids, and return raw exception text.
These cover the current behaviour.
"""

import re

from fastapi.testclient import TestClient

from server import app, authorize_request

# The default TestClient client host is "testclient", which the server treats as
# loopback. Tests that need a network caller pass an explicit client address.

REMOTE = ("203.0.113.9", 45678)


def test_analyze_frames_accepts_empty_batches():
    # Entering the context manager runs the lifespan startup, which is what
    # creates the `jobs` table. Without it the handler fails with
    # "no such table: jobs" rather than reporting a real result.
    with TestClient(app) as client:
        response = client.post(
            "/analyze-frames",
            json={"videoId": "clip", "totalDuration": 0, "frames": []},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    # Deliberately not asserting an exact length or alphabet: the id is generated
    # by `_new_job_id`, and its strength is allowed to change without rewriting
    # this. See the dedicated strength test below.
    assert re.fullmatch(r"[A-Za-z0-9_-]{16,}", body["jobId"]), body["jobId"]


def test_empty_batch_job_reaches_a_terminal_state_with_zero_frames():
    with TestClient(app) as client:
        job_id = client.post(
            "/analyze-frames",
            json={"videoId": "clip", "totalDuration": 0, "frames": []},
        ).json()["jobId"]

        job = client.get(f"/jobs/{job_id}").json()

    assert job["status"] == "completed", job
    assert job["result"]["totalFrames"] == 0
    assert job["result"]["batches"] == [{"batchIndex": 0, "descriptions": []}]


def test_unknown_job_reports_unknown_rather_than_500():
    with TestClient(app) as client:
        response = client.get("/jobs/doesnotexist")

    assert response.status_code == 200
    assert response.json()["status"] == "unknown"


def test_health_reports_ok():
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


class TestJobIdStrength:
    def test_job_ids_are_not_short_hex_strings(self):
        """They were `uuid4().hex[:8]`: 32 bits, enumerable and collidable."""
        with TestClient(app) as client:
            job_id = client.post(
                "/analyze-frames",
                json={"videoId": "clip", "totalDuration": 0, "frames": []},
            ).json()["jobId"]

        assert len(job_id) >= 22
        assert not re.fullmatch(r"[0-9a-f]{8}", job_id)

    def test_job_ids_do_not_repeat(self):
        with TestClient(app) as client:
            ids = {
                client.post(
                    "/analyze-frames",
                    json={"videoId": "clip", "totalDuration": 0, "frames": []},
                ).json()["jobId"]
                for _ in range(5)
            }

        assert len(ids) == 5


class TestNetworkAccess:
    def test_a_remote_caller_is_refused_when_no_token_is_configured(self, monkeypatch):
        monkeypatch.delenv("KOVE_ENGINE_TOKEN", raising=False)
        with TestClient(app, client=REMOTE) as client:
            response = client.post(
                "/analyze-frames",
                json={"videoId": "clip", "totalDuration": 0, "frames": []},
            )

        assert response.status_code == 503
        assert "KOVE_ENGINE_TOKEN" in response.json()["error"]

    def test_a_remote_caller_with_the_token_is_served(self, monkeypatch):
        monkeypatch.setenv("KOVE_ENGINE_TOKEN", "tok")
        with TestClient(app, client=REMOTE) as client:
            response = client.post(
                "/analyze-frames",
                json={"videoId": "clip", "totalDuration": 0, "frames": []},
                headers={"Authorization": "Bearer tok"},
            )

        assert response.status_code == 200

    def test_a_wrong_token_is_rejected(self, monkeypatch):
        monkeypatch.setenv("KOVE_ENGINE_TOKEN", "tok")
        with TestClient(app, client=REMOTE) as client:
            response = client.post(
                "/analyze-frames",
                json={"videoId": "clip", "totalDuration": 0, "frames": []},
                headers={"Authorization": "Bearer nope"},
            )

        assert response.status_code == 401

    def test_loopback_is_served_without_a_token(self, monkeypatch):
        monkeypatch.delenv("KOVE_ENGINE_TOKEN", raising=False)
        with TestClient(app) as client:
            response = client.post(
                "/analyze-frames",
                json={"videoId": "clip", "totalDuration": 0, "frames": []},
            )

        assert response.status_code == 200

    def test_loopback_still_needs_the_token_once_one_is_configured(self, monkeypatch):
        """A reverse proxy on the host makes remote callers look loopback."""
        monkeypatch.setenv("KOVE_ENGINE_TOKEN", "tok")
        with TestClient(app) as client:
            response = client.post(
                "/analyze-frames",
                json={"videoId": "clip", "totalDuration": 0, "frames": []},
            )

        assert response.status_code == 401

    def test_health_is_reachable_without_a_token(self, monkeypatch):
        monkeypatch.setenv("KOVE_ENGINE_TOKEN", "tok")
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200

    def test_authorize_returns_none_for_an_allowed_request(self, monkeypatch):
        from starlette.requests import Request

        monkeypatch.delenv("KOVE_ENGINE_TOKEN", raising=False)
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/analyze",
            "headers": [],
            "client": ("127.0.0.1", 1234),
        }

        assert authorize_request(Request(scope)) is None


class TestVideoPathRestriction:
    def _media(self, tmp_path, monkeypatch, name="clip.mp4"):
        monkeypatch.setenv("KOVE_MEDIA_ROOTS", str(tmp_path))
        path = tmp_path / name
        path.write_bytes(b"not really a video")
        return path

    def test_accepts_a_media_file_inside_the_configured_root(self, tmp_path, monkeypatch):
        path = self._media(tmp_path, monkeypatch)
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": [str(path)]})

        assert response.status_code == 200
        assert "jobId" in response.json()

    def test_rejects_a_path_outside_the_roots(self, tmp_path, monkeypatch):
        self._media(tmp_path, monkeypatch)
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": ["/etc/hosts"]})

        assert response.status_code == 400
        assert "media roots" in response.json()["error"]

    def test_rejects_directory_traversal(self, tmp_path, monkeypatch):
        self._media(tmp_path, monkeypatch)
        traversal = f"{tmp_path}/../../etc/passwd"
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": [traversal]})

        assert response.status_code == 400

    def test_rejects_a_non_media_extension_inside_the_root(self, tmp_path, monkeypatch):
        path = self._media(tmp_path, monkeypatch, name="secrets.txt")
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": [str(path)]})

        assert response.status_code == 400
        assert "extension" in response.json()["error"]

    def test_rejects_a_directory(self, tmp_path, monkeypatch):
        monkeypatch.setenv("KOVE_MEDIA_ROOTS", str(tmp_path))
        (tmp_path / "folder.mp4").mkdir()
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": [str(tmp_path / "folder.mp4")]})

        assert response.status_code == 400

    def test_rejects_a_missing_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("KOVE_MEDIA_ROOTS", str(tmp_path))
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": [str(tmp_path / "nope.mp4")]})

        assert response.status_code == 400
        assert "does not exist" in response.json()["error"]

    def test_the_error_message_does_not_echo_the_resolved_path(self, tmp_path, monkeypatch):
        monkeypatch.setenv("KOVE_MEDIA_ROOTS", str(tmp_path))
        with TestClient(app) as client:
            response = client.post("/analyze", json={"video_paths": ["/etc/hosts"]})

        assert "/etc/hosts" not in response.json()["error"]

    def test_a_failing_job_reports_no_internals(self, tmp_path, monkeypatch):
        """The orchestrator fails on this fake file; the client must not see why."""
        path = self._media(tmp_path, monkeypatch)
        with TestClient(app) as client:
            job_id = client.post("/analyze", json={"video_paths": [str(path)]}).json()["jobId"]
            job = client.get(f"/jobs/{job_id}").json()

        assert job["status"] == "failed"
        error = job["result"]["error"]
        # Generic message plus a correlation id, and no traceback, path, or
        # library name anywhere in it.
        assert error == "Analysis failed. See engine logs for details."
        assert job["result"]["jobId"] == job_id
        assert str(tmp_path) not in error
        assert "ffprobe" not in error
        assert "Traceback" not in error
