"""SQLite-backed job store for the analysis server.

Single-user, localhost tool: one SQLite file, no scheduler. Jobs older than
``JOB_TTL_SECONDS`` are evicted by a sweep that runs at the start of every
``/analyze-frames`` request (sweep-on-request), which matches the
"dev server started by hand" nature of this service.
"""

from __future__ import annotations

import json
import time

import aiosqlite

JOB_TTL_SECONDS = 3600.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    payload TEXT NOT NULL,
    result TEXT
);
"""


class JobStore:
    """Async job persistence for analysis runs.

    Statuses are plain strings ("pending" | "running" | "completed" | "failed");
    ``payload`` carries the request parameters and ``result`` the JSON-serializable
    outcome (or an error object for failed jobs).
    """

    def __init__(self, path: str):
        self.path = path

    async def init(self) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(SCHEMA)
            await db.commit()

    async def sweep_expired(self, now: float | None = None) -> int:
        """DELETE jobs older than the TTL. Returns how many rows were removed."""
        cutoff = (time.time() if now is None else now) - JOB_TTL_SECONDS
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute("DELETE FROM jobs WHERE created_at < ?", (cutoff,))
            await db.commit()
            return cursor.rowcount or 0

    async def create(self, job_id: str, payload: dict, now: float | None = None) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO jobs (id, status, created_at, payload, result) VALUES (?, ?, ?, ?, NULL)",
                (job_id, "pending", time.time() if now is None else now, json.dumps(payload)),
            )
            await db.commit()

    async def set_status(
        self,
        job_id: str,
        status: str,
        result: dict | None = None,
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE jobs SET status = ?, result = ? WHERE id = ?",
                (status, json.dumps(result) if result is not None else None, job_id),
            )
            await db.commit()

    async def get(self, job_id: str) -> dict | None:
        """Return {id, status, created_at, payload, result} or None."""
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT id, status, created_at, payload, result FROM jobs WHERE id = ?",
                (job_id,),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "status": row["status"],
            "created_at": row["created_at"],
            "payload": json.loads(row["payload"]) if row["payload"] else {},
            "result": json.loads(row["result"]) if row["result"] else None,
        }
