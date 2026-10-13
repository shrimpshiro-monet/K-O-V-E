"""Call production TypeScript planner code from the Python harness.

The subprocess boundary is the repo's own vitest running
`tools/kove-eval/bridge/beat-snap.test.ts`, so the code under test is the same
module the product imports. Failures are loud: a bridge that silently returns
"no grid" would make the rhythm metrics meaningless.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from . import repo

VITEST_CONFIG = "vitest.craft.config.ts"
BRIDGE_RELATIVE = "tools/kove-eval/bridge/beat-snap.test.ts"


class BridgeError(RuntimeError):
    pass


def _vitest_binary() -> Path:
    path = repo.CREATION_SCHEMA / "node_modules" / ".bin" / "vitest"
    if not path.exists():
        raise BridgeError(
            f"vitest not found at {path}; the bridge needs the workspace installed "
            "(pnpm install) to run production planner code"
        )
    return path


def call(job: dict, timeout: float = 240.0) -> dict:
    """Run one bridge job and return its JSON result."""
    with tempfile.TemporaryDirectory(prefix="kove-craft-bridge-") as tmp:
        job_path = Path(tmp) / "job.json"
        out_path = Path(tmp) / "out.json"
        job_path.write_text(json.dumps(job))

        env = dict(os.environ)
        env["KOVE_CRAFT_JOB"] = str(job_path)
        env["KOVE_CRAFT_OUT"] = str(out_path)
        env.setdefault("NODE_EXTRA_CA_CERTS", "/usr/local/share/ca-certificates/e2b-ca.crt")
        env.setdefault("ELECTRON_SKIP_BINARY_DOWNLOAD", "1")
        env.setdefault("npm_config_verify_deps_before_run", "false")

        completed = subprocess.run(
            [str(_vitest_binary()), "run", "--config", VITEST_CONFIG, BRIDGE_RELATIVE],
            cwd=str(repo.CREATION_SCHEMA),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            check=False,
        )
        if not out_path.exists():
            tail = "\n".join((completed.stdout + completed.stderr).strip().splitlines()[-25:])
            raise BridgeError(
                f"bridge produced no output (exit {completed.returncode})\n{tail}"
            )
        return json.loads(out_path.read_text())


def snap_plan(
    plan: dict,
    segment_map: dict | None = None,
    *,
    cut_offset_seconds: float | None = None,
    subdivision_beats: int | None = None,
    reference_shot_lengths_in_beats: list[float] | None = None,
) -> dict:
    """Run the shipped `snapPlanToBeatGrid` over a plan."""
    options: dict = {}
    if cut_offset_seconds is not None:
        options["cutOffsetSeconds"] = cut_offset_seconds
    if subdivision_beats is not None:
        options["subdivisionBeats"] = subdivision_beats
    if reference_shot_lengths_in_beats:
        options["referenceShotLengthsInBeats"] = reference_shot_lengths_in_beats
    return call(
        {"op": "snap", "plan": plan, "segmentMap": segment_map, "options": options}
    )


def align_cuts(cuts: list[float], grid: dict, subdivision_beats: int = 1) -> dict:
    """Judge cut times against a grid with the shipped tolerance."""
    return call(
        {
            "op": "align",
            "cuts": cuts,
            "grid": grid,
            "options": {"subdivisionBeats": subdivision_beats},
        }
    )


def grid_for(
    plan: dict, segment_map: dict | None = None, **options: object
) -> dict | None:
    """The grid the shipped resolver would use for this plan."""
    result = call(
        {"op": "grid", "plan": plan, "segmentMap": segment_map, "options": options}
    )
    return result["grid"]
