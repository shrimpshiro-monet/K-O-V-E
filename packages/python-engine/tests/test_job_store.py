"""Job store behavior: persistence, status transitions, TTL sweep."""

import time

import pytest
import pytest_asyncio

from kove_engine.job_store import JOB_TTL_SECONDS, JobStore


@pytest_asyncio.fixture
async def store(tmp_path):
    job_store = JobStore(str(tmp_path / "jobs.db"))
    await job_store.init()
    return job_store


@pytest.mark.asyncio
async def test_create_and_get_roundtrip(store):
    await store.create("abc123", {"frames": 4})
    job = await store.get("abc123")
    assert job is not None
    assert job["status"] == "pending"
    assert job["payload"] == {"frames": 4}
    assert job["result"] is None


@pytest.mark.asyncio
async def test_unknown_job_returns_none(store):
    assert await store.get("missing") is None


@pytest.mark.asyncio
async def test_status_transitions_with_result(store):
    await store.create("j1", {})
    await store.set_status("j1", "running")
    assert (await store.get("j1"))["status"] == "running"

    await store.set_status("j1", "completed", {"batches": [], "totalFrames": 0})
    job = await store.get("j1")
    assert job["status"] == "completed"
    assert job["result"] == {"batches": [], "totalFrames": 0}


@pytest.mark.asyncio
async def test_failed_job_keeps_its_error_result(store):
    await store.create("j2", {})
    await store.set_status("j2", "failed", {"error": "boom"})
    job = await store.get("j2")
    assert job["status"] == "failed"
    assert job["result"] == {"error": "boom"}


@pytest.mark.asyncio
async def test_sweep_evicts_only_expired_jobs(store):
    now = time.time()
    # Fresh job, one job just inside the TTL, one just past it.
    await store.create("fresh", {}, now=now)
    await store.create("edge", {}, now=now - JOB_TTL_SECONDS + 1)
    await store.create("stale", {}, now=now - JOB_TTL_SECONDS - 1)

    removed = await store.sweep_expired(now=now)

    assert removed == 1
    assert await store.get("fresh") is not None
    assert await store.get("edge") is not None
    assert await store.get("stale") is None


@pytest.mark.asyncio
async def test_sweep_is_idempotent(store):
    now = time.time()
    await store.create("stale", {}, now=now - JOB_TTL_SECONDS - 10)
    assert await store.sweep_expired(now=now) == 1
    assert await store.sweep_expired(now=now) == 0
