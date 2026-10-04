from fastapi.testclient import TestClient

from server import app


def test_analyze_frames_accepts_empty_batches():
    client = TestClient(app)

    response = client.post(
        "/analyze-frames",
        json={"videoId": "clip", "totalDuration": 0, "frames": []},
    )

    assert response.status_code == 200
    assert response.json()["totalFrames"] == 0
    assert response.json()["batches"] == [{"batchIndex": 0, "descriptions": []}]
