"""Kove Advanced transcription service (GPU).

Access control
--------------
Every endpoint except ``/health`` requires ``Authorization: Bearer <token>``
matching ``KOVE_TRANSCRIBE_TOKEN``. With no token configured the service refuses
to serve (``503``) instead of running open — it was previously wide open, and
``setup.sh`` starts it on a cloud GPU host with ``8000:8000`` published. An
unauthenticated endpoint that bills GPU time per request is somebody else's
compute budget.

Limits
------
``KOVE_TRANSCRIBE_MAX_UPLOAD_BYTES`` caps one upload (default 200 MB) and the
body is streamed to disk in chunks rather than read into memory whole, which is
what the previous revision did — a single large PUT could exhaust the host's RAM
before the model ever loaded.
``KOVE_TRANSCRIBE_MAX_CONCURRENT_JOBS`` caps simultaneous transcriptions (default
2). Every job holds GPU memory, so queuing without a bound is how one caller
starves the box.
``KOVE_TRANSCRIBE_ALLOWED_ORIGINS`` overrides the browser origin allowlist.

Failure reporting
-----------------
A failed job stores a generic message and logs the exception. The previous
revision returned ``str(exception)`` to the client, which hands over absolute
paths, library internals and — for the model and translator alike — whatever the
underlying error happened to include.
"""

import asyncio
import logging
import os
import re
import secrets
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Optional

import uvicorn
from deep_translator import GoogleTranslator
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

logger = logging.getLogger("kove.transcribe")

TOKEN_ENV = "KOVE_TRANSCRIBE_TOKEN"

DEFAULT_ALLOWED_ORIGINS = [
    "https://kove-advanced.video",
    "https://www.kove-advanced.video",
    "https://app.kove-advanced.video",
    "https://editor.kove-advanced.video",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:5174",
    "http://localhost:5175",
]


def _int_env(name: str, default: int) -> int:
    """Positive int from the environment, falling back rather than crashing."""
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def allowed_origins() -> list[str]:
    raw = os.environ.get("KOVE_TRANSCRIBE_ALLOWED_ORIGINS") or ""
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or DEFAULT_ALLOWED_ORIGINS


MAX_UPLOAD_BYTES = _int_env("KOVE_TRANSCRIBE_MAX_UPLOAD_BYTES", 200 * 1024 * 1024)
MAX_CONCURRENT_JOBS = _int_env("KOVE_TRANSCRIBE_MAX_CONCURRENT_JOBS", 2)
UPLOAD_CHUNK_BYTES = 1024 * 1024
JOB_TTL_SECONDS = 600

GENERIC_JOB_FAILURE = "Transcription failed. See the service logs for details."


class _BodyTooLargeError(Exception):
    """Raised from the receive wrapper once a request body passes the cap."""


class BodySizeLimitMiddleware:
    """Refuse oversized bodies before anything buffers them.

    Starlette parses the multipart body and spools the file part to a temp file
    *before* the handler runs, so a cap enforced only in the handler fires after
    the bytes have already landed on disk. This checks `Content-Length` when the
    client sends one and counts streamed bytes otherwise, which is the only point
    where the limit can actually stop an upload.
    """

    def __init__(self, app, limit: int) -> None:
        self.app = app
        self.limit = limit

    @staticmethod
    async def _reject(send) -> None:
        body = (
            b'{"error":"upload_too_large","detail":"Request body exceeds the '
            b'configured limit (KOVE_TRANSCRIBE_MAX_UPLOAD_BYTES)."}'
        )
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        raw_length = dict(scope.get("headers") or []).get(b"content-length")
        if raw_length is not None:
            try:
                declared = int(raw_length)
            except ValueError:
                declared = None
            if declared is not None and declared > self.limit:
                await self._reject(send)
                return

        received = 0
        started = False

        async def counting_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit:
                    raise _BodyTooLargeError
            return message

        async def watching_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, watching_send)
        except _BodyTooLargeError:
            if not started:
                await self._reject(send)
            else:  # pragma: no cover - a response already began; nothing to add
                raise


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_model()
    yield


def create_app(upload_limit: Optional[int] = None) -> FastAPI:
    """Build the service.

    The upload cap is injectable so a test can exercise it without shipping a
    smaller limit or rebuilding the module.
    """
    application = FastAPI(
        title="Kove Advanced Transcription API (GPU)", lifespan=lifespan
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    # Added last, so it runs first: the body cap must reject an oversized upload
    # before CORS or the handler does any work.
    application.add_middleware(
        BodySizeLimitMiddleware, limit=upload_limit or MAX_UPLOAD_BYTES
    )
    return application


app = create_app()

whisper_model: Optional[WhisperModel] = None

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")


@dataclass
class TranscriptionJob:
    id: str
    status: str = "processing"
    progress: float = 0
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)


jobs: dict[str, TranscriptionJob] = {}

# Jobs currently holding the GPU. Decremented by the wrapper in `_run_job`, so an
# unexpected crash cannot leak a slot and wedge the service at its own limit.
active_jobs = 0

# Strong references to in-flight tasks: asyncio only keeps weak ones, so an
# unreferenced task can be collected mid-transcription.
_tasks: set[asyncio.Task] = set()


def _token() -> Optional[str]:
    value = (os.environ.get(TOKEN_ENV) or "").strip()
    return value or None


def _presented_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def authorize_request(request: Request) -> Optional[JSONResponse]:
    """Error response when the caller may not use this service, else None.

    Fails closed: with no token configured nothing is served, because this
    process spends GPU time on every request and is deployed on a public host.
    """
    token = _token()
    if token is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": "transcribe_unconfigured",
                "detail": (
                    f"{TOKEN_ENV} is unset, so this service refuses to serve. "
                    "Set it on the service and give the client the same value."
                ),
            },
        )
    presented = _presented_token(request)
    if not presented or not secrets.compare_digest(presented, token):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return None


def cleanup_expired_jobs():
    now = time.time()
    expired = [
        jid for jid, job in jobs.items() if now - job.created_at > JOB_TTL_SECONDS
    ]
    for jid in expired:
        del jobs[jid]


def get_model() -> WhisperModel:
    global whisper_model
    if whisper_model is None:
        print(f"Loading Whisper model ({MODEL_SIZE}) on {DEVICE} ({COMPUTE_TYPE})...")
        whisper_model = WhisperModel(
            MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE
        )
        print("Model loaded!")
    return whisper_model


def _safe_suffix(filename: Optional[str]) -> str:
    """A temp-file suffix derived from the upload name, never used verbatim."""
    suffix = os.path.splitext(os.path.basename(filename or ""))[1].lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ".wav"


def _run_transcription(
    job_id: str,
    tmp_path: str,
    language: Optional[str],
    target_language: Optional[str],
):
    job = jobs[job_id]
    try:
        job.progress = 10

        model = get_model()

        transcribe_kwargs = {
            "word_timestamps": True,
            "vad_filter": True,
        }
        if language and isinstance(language, str) and len(language) <= 5:
            transcribe_kwargs["language"] = language

        use_whisper_translate = (
            target_language
            and target_language == "en"
            and (not language or language != "en")
        )
        if use_whisper_translate:
            transcribe_kwargs["task"] = "translate"

        job.progress = 20

        segments, info = model.transcribe(tmp_path, **transcribe_kwargs)

        words = []
        full_text = []

        job.progress = 50

        for segment in segments:
            full_text.append(segment.text.strip())
            if segment.words:
                for word in segment.words:
                    words.append(
                        {
                            "word": word.word.strip(),
                            "start": round(word.start, 2),
                            "end": round(word.end, 2),
                        }
                    )

        job.progress = 80

        text = " ".join(full_text)
        detected_language = info.language

        need_translation = (
            target_language
            and target_language != "en"
            and target_language != detected_language
            and not use_whisper_translate
        )

        if need_translation:
            try:
                translator = GoogleTranslator(
                    source=detected_language if detected_language else "auto",
                    target=target_language,
                )
                text = translator.translate(text)
                for w in words:
                    if len(w["word"]) > 1:
                        w["word"] = translator.translate(w["word"])
            except Exception:
                # Translation is best-effort: the transcript is still useful, and
                # the exception may name the upstream service's internals.
                logger.exception("job %s: translation failed", job_id)

        job.progress = 100
        job.status = "completed"
        job.result = {
            "text": text,
            "word_count": len(words),
            "words": words,
            "language": detected_language,
            "target_language": target_language,
            "duration": info.duration,
        }
    except Exception:
        # The client gets a status and the job id; the traceback (absolute paths,
        # library internals) goes to the log, where it is correlated by that id.
        logger.exception("job %s: transcription failed", job_id)
        job.status = "failed"
        job.error = GENERIC_JOB_FAILURE
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def _run_job(
    job_id: str,
    tmp_path: str,
    language: Optional[str],
    target_language: Optional[str],
):
    global active_jobs
    try:
        await asyncio.to_thread(
            _run_transcription, job_id, tmp_path, language, target_language
        )
    except Exception:
        # `_run_transcription` handles its own errors; this is the last resort so
        # a job can never sit in "processing" forever.
        logger.exception("job %s: unhandled failure", job_id)
        job = jobs.get(job_id)
        if job is not None and job.status == "processing":
            job.status = "failed"
            job.error = GENERIC_JOB_FAILURE
    finally:
        active_jobs -= 1


async def _store_upload(audio: UploadFile) -> str:
    """Stream an upload to a temp file, refusing anything over the cap."""
    tmp = tempfile.NamedTemporaryFile(
        delete=False, suffix=_safe_suffix(audio.filename)
    )
    total = 0
    try:
        while True:
            chunk = await audio.read(UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        "Upload exceeds "
                        f"{MAX_UPLOAD_BYTES} bytes "
                        "(KOVE_TRANSCRIBE_MAX_UPLOAD_BYTES)."
                    ),
                )
            tmp.write(chunk)
        tmp.close()
        return tmp.name
    except BaseException:
        tmp.close()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


async def _accept_job(
    request: Request,
    audio: UploadFile,
    language: Optional[str],
    target_language: Optional[str],
):
    global active_jobs
    denied = authorize_request(request)
    if denied is not None:
        return denied

    if not audio.filename:
        raise HTTPException(status_code=400, detail="No audio file provided")

    cleanup_expired_jobs()

    if active_jobs >= MAX_CONCURRENT_JOBS:
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": "10"},
            content={
                "error": "too_many_jobs",
                "detail": (
                    f"{active_jobs} transcription(s) in progress; retry shortly."
                ),
            },
        )

    tmp_path = await _store_upload(audio)

    job_id = str(uuid.uuid4())
    jobs[job_id] = TranscriptionJob(id=job_id)
    active_jobs += 1

    task = asyncio.create_task(
        _run_job(job_id, tmp_path, language, target_language)
    )
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)

    return {"jobId": job_id, "status": "processing"}


@app.post("/transcribe")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
    target_language: Optional[str] = Form(None),
):
    return await _accept_job(request, audio, language, target_language)


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, request: Request):
    denied = authorize_request(request)
    if denied is not None:
        return denied

    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    response = {
        "jobId": job.id,
        "status": job.status,
        "progress": job.progress,
    }

    if job.status == "completed":
        response["result"] = job.result
    elif job.status == "failed":
        response["error"] = job.error

    return response


@app.post("/")
async def transcribe_root(
    request: Request,
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
    target_language: Optional[str] = Form(None),
):
    return await _accept_job(request, audio, language, target_language)


@app.get("/health")
async def health():
    gpu_available = False
    gpu_name = None
    try:
        import torch

        gpu_available = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if gpu_available else None
    except ImportError:
        pass

    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "gpu": gpu_name,
        "gpu_available": gpu_available,
        "ready": whisper_model is not None,
        "active_jobs": active_jobs,
        "jobs_retained": len(jobs),
        "authenticated": _token() is not None,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
