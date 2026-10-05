"""KOVE Analysis Engine — HTTP server wrapping the Python orchestrator.

Job model (v2): POST endpoints create a SQLite-persisted job and return
``{jobId}`` immediately; work runs in a FastAPI BackgroundTask; clients poll
``GET /jobs/{id}`` until the status is terminal. The previous SSE progress
endpoint and await-to-completion responses were removed together with the
dead AnalysisProgressCard frontend consumer.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from kove_engine.job_store import JobStore
from kove_engine.orchestrator import Orchestrator

# Single file next to the server; override with KOVE_JOBS_DB for tests/relocation.
JOBS_DB_PATH = os.environ.get(
    "KOVE_JOBS_DB", str(Path(__file__).resolve().parent / "jobs.db")
)
job_store = JobStore(JOBS_DB_PATH)


class AnalyzeRequest(BaseModel):
    video_paths: list[str]
    baseline_fps: float = 1.5
    burst_fps: float = 10.0
    scene_threshold: float = 0.3


class FrameData(BaseModel):
    timestamp: float
    imageData: str  # base64 JPEG
    width: int
    height: int


class FrameBatch(BaseModel):
    batchIndex: int
    frames: list[FrameData]


class VisionRequest(BaseModel):
    videoId: str
    totalDuration: float
    frames: list[FrameBatch]


@asynccontextmanager
async def lifespan(app: FastAPI):
    await job_store.init()
    yield


app = FastAPI(title="KOVE Analysis Engine", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "python", "version": "0.2.0"}


def _new_job_id() -> str:
    return uuid.uuid4().hex[:8]


@app.post("/analyze")
async def analyze(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    """Start a video-path analysis job; returns immediately with {jobId}."""
    job_id = _new_job_id()
    await job_store.create(job_id, req.model_dump())
    background_tasks.add_task(_run_analysis_job, job_id, req)
    return {"jobId": job_id, "status": "pending"}


async def _run_analysis_job(job_id: str, req: AnalyzeRequest) -> None:
    await job_store.set_status(job_id, "running")
    try:
        orchestrator = Orchestrator(
            baseline_fps=req.baseline_fps,
            burst_fps=req.burst_fps,
            scene_threshold=req.scene_threshold,
        )
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, _run_analysis, orchestrator, req.video_paths
        )
        await job_store.set_status(job_id, "completed", result)
    except Exception as exc:  # noqa: BLE001 — job must always reach a terminal state
        await job_store.set_status(job_id, "failed", {"error": str(exc)})


def _run_analysis(orchestrator: Orchestrator, video_paths: list[str]) -> dict:
    import time

    start = time.monotonic()
    all_videos = []
    reports = []

    for path in video_paths:
        sm, report = orchestrator.analyze_with_report(path)
        all_videos.extend(sm.videos)
        reports.append(report)

    from kove_engine.types import SegmentMap

    segment_map = SegmentMap(videos=all_videos)
    elapsed_ms = int((time.monotonic() - start) * 1000)

    total_frames = sum(
        len(seg.description.split(" | ")) for v in all_videos for seg in v.segments
    )

    return {
        "segmentMap": segment_map.model_dump(),
        "referenceAnalysis": {"analysisVersion": "1.1.0", "videos": reports},
        "processingTimeMs": elapsed_ms,
        "frameCount": total_frames,
        "segmentCount": sum(len(v.segments) for v in all_videos),
    }


@app.post("/analyze-frames")
async def analyze_frames(req: VisionRequest, background_tasks: BackgroundTasks):
    """Accept base64 frames (same as Cloudflare Worker), run local analysis.

    Returns {jobId} immediately; poll GET /jobs/{jobId}. Every call first
    sweeps jobs older than the TTL (sweep-on-request; no background scheduler).
    """
    await job_store.sweep_expired()

    job_id = _new_job_id()
    payload = {
        "videoId": req.videoId,
        "totalDuration": req.totalDuration,
        "frameCount": sum(len(batch.frames) for batch in req.frames),
    }
    await job_store.create(job_id, payload)
    background_tasks.add_task(_run_frame_analysis_job, job_id, req)
    return {"jobId": job_id, "status": "pending"}


async def _run_frame_analysis_job(job_id: str, req: VisionRequest) -> None:
    await job_store.set_status(job_id, "running")
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _run_frame_analysis, req)
        await job_store.set_status(job_id, "completed", result)
    except (ValueError, OSError) as exc:
        await job_store.set_status(
            job_id, "failed", {"error": f"Frame analysis failed: {exc}"}
        )
    except Exception as exc:  # noqa: BLE001 — job must always reach a terminal state
        await job_store.set_status(job_id, "failed", {"error": str(exc)})


def _run_frame_analysis(req: VisionRequest) -> dict:
    import base64
    import shutil
    import tempfile
    from pathlib import Path

    all_frames = []
    for batch in req.frames:
        all_frames.extend(batch.frames)
    all_frames.sort(key=lambda f: f.timestamp)

    if not all_frames:
        return {"batches": [{"batchIndex": 0, "descriptions": []}], "totalFrames": 0, "processingTimeMs": 0}

    tmpdir = tempfile.mkdtemp(prefix="kove_")
    try:
        frame_paths = []
        for i, frame in enumerate(all_frames):
            frame_path = Path(tmpdir) / f"frame_{i:04d}.jpg"
            frame_bytes = base64.b64decode(frame.imageData, validate=True)
            frame_path.write_bytes(frame_bytes)
            frame_paths.append((frame.timestamp, str(frame_path)))

        from kove_engine.analyzers.face_analyzer import FaceAnalyzer
        from kove_engine.analyzers.motion_analyzer import MotionAnalyzer
        from kove_engine.analyzers.visual_analyzer import VisualAnalyzer
        from kove_engine.classifier import Classifier
        from kove_engine.types import AudioResult
        from kove_engine.types import FrameData as EngineFrameData

        motion_analyzer = MotionAnalyzer()
        face_analyzer = FaceAnalyzer()
        visual_analyzer = VisualAnalyzer()
        classifier = Classifier()

        descriptions = []
        prev_path = None

        for timestamp, image_path in frame_paths:
            frame_data = EngineFrameData(
                timestamp=timestamp,
                image_path=image_path,
                prev_frame_path=prev_path,
            )

            motion = motion_analyzer.analyze(frame_data)
            face = face_analyzer.analyze(image_path)
            visual = visual_analyzer.analyze(image_path)

            audio_result = AudioResult(
                has_dialogue=False, is_silence=False, has_music=False,
                bpm=None, rms_energy=0.3,
            )

            result = classifier.classify(motion, audio_result, face, visual, False)

            descriptions.append({
                "timestamp": timestamp,
                "description": f"{result.scene_type.value} - {motion.motion_level.value} motion",
                "sceneType": result.scene_type.value,
                "motionLevel": motion.motion_level.value,
                "hasDialogue": False,
                "confidence": result.confidence,
            })

            prev_path = image_path

        return {
            "batches": [{"batchIndex": 0, "descriptions": descriptions}],
            "totalFrames": len(descriptions),
            "processingTimeMs": 0,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Poll target: {status, result|null}. Terminal statuses: completed/failed."""
    job = await job_store.get(job_id)
    if job is None:
        return {"status": "unknown", "error": "job not found"}
    return {"status": job["status"], "result": job["result"]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
