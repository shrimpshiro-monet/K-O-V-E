# GPU transcription service

Self-hosted Whisper transcription (`faster-whisper`) behind a FastAPI service,
for hosts with a GPU. `setup.sh` provisions Docker + the NVIDIA container toolkit
on a fresh instance and starts the service.

## Access control

Every endpoint except `/health` requires a bearer token:

```
Authorization: Bearer $KOVE_TRANSCRIBE_TOKEN
```

With no token configured the service returns `503` and serves nothing. It
previously had no authentication at all, while `setup.sh` publishes port 8000 on a
cloud GPU host — every request spends GPU time, so an open endpoint is somebody
else's compute bill.

`setup.sh` generates a token into `.env` (gitignored) on first run and prints it.
Set it yourself instead to choose the value:

```bash
export KOVE_TRANSCRIBE_TOKEN="$(openssl rand -hex 32)"
```

Compose refuses to start without it. Publish the port to the clients that need it
rather than to the world — the token is one control, the security group is the
other.

## Limits

| Variable | Default | Effect |
| --- | --- | --- |
| `KOVE_TRANSCRIBE_MAX_UPLOAD_BYTES` | 209715200 (200 MB) | Largest request body. Enforced in middleware, before the body is buffered. |
| `KOVE_TRANSCRIBE_MAX_CONCURRENT_JOBS` | 2 | Simultaneous transcriptions. Further requests get `429` with `Retry-After`. |
| `KOVE_TRANSCRIBE_ALLOWED_ORIGINS` | the project's origins + localhost dev ports | Comma-separated browser origin allowlist. |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `large-v3-turbo` / `cuda` / `float16` | Model and execution. |

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/transcribe` (and `/`) | required | Multipart upload as `audio`, optional `language` and `target_language` form fields. Returns `{jobId, status}`. |
| `GET` | `/jobs/{job_id}` | required | `{jobId, status, progress}` plus `result` when complete or `error` when failed. Jobs are kept for 10 minutes. |
| `GET` | `/health` | open | Probe target: model, device, `ready`, `active_jobs`, and whether a token is configured. |

A failed job returns a generic message; the exception goes to the service log,
correlated by the job id, because the raw text carries absolute paths and library
internals.

## Tests

The service's GPU dependency and the translation client are stubbed in
`tests/stubs.py`, so the whole request path (routing, middleware, auth, upload
cap, job lifecycle, error reporting) runs on a CPU box:

```bash
pip install -r requirements.txt pytest
python -m pytest tests/ -q
```

## CPU-only hosts

`docker-compose.cpu.yml` runs the same service with `WHISPER_DEVICE=cpu`, which is
slow but needs no GPU. It requires the same token.
