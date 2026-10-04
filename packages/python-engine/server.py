"""KOVE Analysis Engine — HTTP server wrapping the Python orchestrator."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from kove_engine.orchestrator import Orchestrator

# In-memory job store
jobs: dict[str, dict] = defaultdict(lambda: {"status": "pending", "progress": [], "result": None})


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
    yield


app = FastAPI(title="KOVE Analysis Engine", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "python", "version": "0.1.0"}


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    job_id = uuid.uuid4().hex[:8]
    jobs[job_id]["status"] = "running"

    orchestrator = Orchestrator(
        baseline_fps=req.baseline_fps,
        burst_fps=req.burst_fps,
        scene_threshold=req.scene_threshold,
    )

    progress_events: list[dict] = []

    def on_progress(event: dict) -> None:
        progress_events.append(event)
        jobs[job_id]["progress"].append(event)

    orchestrator.on_progress = on_progress

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _run_analysis, orchestrator, req.video_paths)

    jobs[job_id]["status"] = "completed"
    jobs[job_id]["result"] = result

    return {
        "jobId": job_id,
        "status": "completed",
        "segmentMap": result["segmentMap"],
        "referenceAnalysis": result["referenceAnalysis"],
        "processingTimeMs": result.get("processingTimeMs", 0),
        "frameCount": result.get("frameCount", 0),
        "segmentCount": result.get("segmentCount", 0),
    }


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
async def analyze_frames(req: VisionRequest):
    """Accept base64 frames (same as Cloudflare Worker), run local analysis."""
    import base64
    import shutil
    import tempfile
    from pathlib import Path

    job_id = uuid.uuid4().hex[:8]
    jobs[job_id]["status"] = "running"

    all_frames = []
    for batch in req.frames:
        all_frames.extend(batch.frames)
    all_frames.sort(key=lambda f: f.timestamp)

    if not all_frames:
        jobs[job_id]["status"] = "completed"
        return {
            "batches": [{"batchIndex": 0, "descriptions": []}],
            "totalFrames": 0,
            "processingTimeMs": 0,
        }

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

        for i, (timestamp, image_path) in enumerate(frame_paths):
            jobs[job_id]["progress"].append({
                "stage": "analyzing_frame",
                "message": f"Analyzing frame {i+1}/{len(frame_paths)}",
                "current": i + 1,
                "total": len(frame_paths),
            })

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

        jobs[job_id]["status"] = "completed"
        return {
            "batches": [{"batchIndex": 0, "descriptions": descriptions}],
            "totalFrames": len(descriptions),
            "processingTimeMs": 0,
        }
    except (ValueError, OSError) as exc:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["result"] = {"error": f"Frame analysis failed: {exc}"}
        return {
            "batches": [{"batchIndex": 0, "descriptions": []}],
            "totalFrames": 0,
            "processingTimeMs": 0,
            "error": str(exc),
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.get("/progress/{job_id}")
async def progress(job_id: str):
    if job_id not in jobs:
        return {"error": "job not found"}

    async def event_generator():
        last_idx = 0
        while True:
            job = jobs[job_id]
            progress_list = job["progress"]

            while last_idx < len(progress_list):
                event = progress_list[last_idx]
                yield {"event": "progress", "data": json.dumps(event)}
                last_idx += 1

            if job["status"] == "completed":
                result = job["result"]
                if result:
                    yield {"event": "done", "data": json.dumps(result)}
                break

            await asyncio.sleep(0.1)

    return EventSourceResponse(event_generator())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
