"""KOVE Analysis Engine — HTTP server wrapping the Python orchestrator.

Job model (v2): POST endpoints create a SQLite-persisted job and return
``{jobId}`` immediately; work runs in a FastAPI BackgroundTask; clients poll
``GET /jobs/{id}`` until the status is terminal. The previous SSE progress
endpoint and await-to-completion responses were removed together with the
dead AnalysisProgressCard frontend consumer.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Media the engine will open. The path allowlist and the realpath containment
# check are the actual defence; this stops the obvious mistakes.
MEDIA_EXTENSIONS = frozenset(
    {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv", ".ts", ".m2ts"}
)

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})


def _auth_token() -> str | None:
    token = os.environ.get("KOVE_ENGINE_TOKEN", "").strip()
    return token or None


def _media_roots() -> list[Path]:
    """Directories /analyze may read from. Default: the working directory.

    Unset means *only* the working directory, not the whole filesystem. Set
    KOVE_MEDIA_ROOTS to a comma-separated list to widen it deliberately.
    """
    configured = os.environ.get("KOVE_MEDIA_ROOTS", "").strip()
    raw = [item for item in configured.split(",") if item.strip()] if configured else [os.getcwd()]
    roots: list[Path] = []
    for item in raw:
        try:
            roots.append(Path(item.strip()).expanduser().resolve())
        except OSError:  # pragma: no cover - defensive
            continue
    return roots


def _is_loopback(request: Request) -> bool:
    client = request.client
    return client is not None and client.host in LOOPBACK_HOSTS


def authorize_request(request: Request) -> JSONResponse | None:
    """Return an error response when the caller may not use this engine.

    With no token configured the engine serves loopback callers only, so a local
    ``uvicorn`` run keeps working while anything reaching it over the network does
    not. With a token configured every caller must present it — including
    loopback, because a reverse proxy on the same host makes remote callers look
    local.
    """
    token = _auth_token()
    presented = ""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        presented = header[7:].strip()

    if token is None:
        if _is_loopback(request):
            return None
        return JSONResponse(
            status_code=503,
            content={
                "error": (
                    "This engine is not configured for network access: KOVE_ENGINE_TOKEN "
                    "is unset, so only loopback clients are served."
                )
            },
        )

    if not presented or not secrets.compare_digest(presented, token):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing token."})
    return None


def _safe_client_error(exc: Exception, job_id: str) -> dict:
    """A terminal-state payload that does not leak the filesystem or internals.

    Tracebacks and exception strings name absolute paths and library internals.
    The detail goes to the log, correlated by job id; the client gets the id.
    """
    logger.exception("job %s failed", job_id)
    return {"error": "Analysis failed. See engine logs for details.", "jobId": job_id}


def _resolve_video_path(candidate: str) -> tuple[Path | None, str | None]:
    """Resolve a requested path against the media roots. Returns (path, error)."""
    if not candidate or candidate.strip() == "":
        return None, "Empty video path."

    try:
        resolved = Path(candidate).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "Video path does not exist or is not readable."

    # Containment before extension: a file outside the roots should be refused
    # for that reason, not for whatever extension it happens to have.
    roots = _media_roots()
    if not any(resolved == root or root in resolved.parents for root in roots):
        return None, "Video path is outside the configured media roots."

    if resolved.suffix.lower() not in MEDIA_EXTENSIONS:
        return None, f"Unsupported media extension: {resolved.suffix or '(none)'}."

    if not resolved.is_file():
        return None, "Video path is not a regular file."

    return resolved, None

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
    scene_adaptive_threshold: float = 3.0


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
    """An unguessable job id.

    This was ``uuid4().hex[:8]`` — 32 bits. A job id is the only thing protecting
    a job's result, so a short one is both enumerable and collidable.
    """
    return secrets.token_urlsafe(24)


@app.post("/analyze")
async def analyze(req: AnalyzeRequest, request: Request, background_tasks: BackgroundTasks):
    """Start a video-path analysis job; returns immediately with {jobId}."""
    denied = authorize_request(request)
    if denied is not None:
        return denied

    resolved: list[str] = []
    for candidate in req.video_paths:
        path, error = _resolve_video_path(candidate)
        if error is not None:
            # The message names the reason, never the resolved absolute path.
            return JSONResponse(status_code=400, content={"error": error})
        resolved.append(str(path))

    job_id = _new_job_id()
    await job_store.create(job_id, {**req.model_dump(), "video_paths": resolved})
    background_tasks.add_task(
        _run_analysis_job, job_id, req.model_copy(update={"video_paths": resolved})
    )
    return {"jobId": job_id, "status": "pending"}


async def _run_analysis_job(job_id: str, req: AnalyzeRequest) -> None:
    await job_store.set_status(job_id, "running")
    try:
        orchestrator = Orchestrator(
            baseline_fps=req.baseline_fps,
            burst_fps=req.burst_fps,
            scene_adaptive_threshold=req.scene_adaptive_threshold,
        )
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, _run_analysis, orchestrator, req.video_paths
        )
        await job_store.set_status(job_id, "completed", result)
    except Exception as exc:  # noqa: BLE001 — job must always reach a terminal state
        await job_store.set_status(job_id, "failed", _safe_client_error(exc, job_id))


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
async def analyze_frames(req: VisionRequest, request: Request, background_tasks: BackgroundTasks):
    """Accept base64 frames (same as Cloudflare Worker), run local analysis.

    Returns {jobId} immediately; poll GET /jobs/{jobId}. Every call first
    sweeps jobs older than the TTL (sweep-on-request; no background scheduler).
    """
    denied = authorize_request(request)
    if denied is not None:
        return denied

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
    except Exception as exc:  # noqa: BLE001 — job must always reach a terminal state
        await job_store.set_status(job_id, "failed", _safe_client_error(exc, job_id))


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
async def get_job(job_id: str, request: Request):
    """Poll target: {status, result|null}. Terminal statuses: completed/failed.

    Authorized like the submit endpoints: a job id is a capability, but it also
    travels through logs, screenshots and bug reports, so a network caller that
    cannot submit should not be able to read someone else's result either.
    """
    denied = authorize_request(request)
    if denied is not None:
        return denied
    job = await job_store.get(job_id)
    if job is None:
        return {"status": "unknown", "error": "job not found"}
    return {"status": job["status"], "result": job["result"]}


def bind_address() -> tuple[str, int]:
    """Host and port for a direct ``python server.py`` run.

    Loopback by default. Authorization already refuses network callers when no
    token is set, but not listening on the world at all is the stronger default:
    a deployment that needs network reach opts in explicitly with
    ``KOVE_ENGINE_HOST=0.0.0.0`` and should set ``KOVE_ENGINE_TOKEN`` with it.
    """
    host = (os.environ.get("KOVE_ENGINE_HOST") or "").strip() or "127.0.0.1"
    try:
        port = int(os.environ.get("KOVE_ENGINE_PORT", "8000"))
    except ValueError:
        port = 8000
    return host, port


if __name__ == "__main__":
    import uvicorn

    _host, _port = bind_address()
    uvicorn.run(app, host=_host, port=_port)
