"""The golden set has to be the same golden set in every process.

A reference whose pixels change between builds is not a reference: every
colour metric measured against it carries the difference, and two contact
sheets from the same committed code stop being comparable. The plan was
always reproducible (cuts, lengths, tempo); the *media* was not, because the
pack renderer was seeded with `hash()`, which Python randomises per process.
"""

from __future__ import annotations

import subprocess
import sys

import numpy as np

from kove_eval.goldens import PACKS, pack_frame, pack_shot_seed

# Each child gets a different PYTHONHASHSEED; the frame must not care.
_CHILD = """
import numpy as np
from kove_eval.goldens import PACKS, pack_frame
for pack in PACKS:
    for t in (0.0, 3.3, 17.9):
        frame = pack_frame(pack, t)
        print(f"{pack.id} {t} {int(frame.astype(np.int64).sum())}")
"""


def test_pack_shot_seed_is_stable_for_a_name_and_sub_shot() -> None:
    assert pack_shot_seed("canopy", 0) == pack_shot_seed("canopy", 0)
    assert pack_shot_seed("canopy", 0) != pack_shot_seed("canopy", 1)
    assert pack_shot_seed("canopy", 0) != pack_shot_seed("city", 0)
    assert 0 <= pack_shot_seed("canopy", 0) < 2**32


def test_frames_do_not_depend_on_the_processs_hash_seed() -> None:
    """The bug this pins: `hash((pack.id, shot))` is per-process random."""
    runs = [
        subprocess.run(
            [sys.executable, "-c", _CHILD],
            capture_output=True,
            text=True,
            check=True,
            env={"PYTHONHASHSEED": seed, "PATH": "/usr/bin:/bin"},
        ).stdout
        for seed in ("0", "1", "424242")
    ]
    assert runs[0] == runs[1] == runs[2], "pack frames differ between processes"


def test_a_frame_is_a_frame() -> None:
    frame = pack_frame(PACKS[0], 3.3)
    assert frame.shape[:2] == (720, 1280)
    assert frame.dtype == np.uint8
    # Not asserted to a specific checksum: a deliberate change to the look of
    # the footage should not fail a test whose point is reproducibility.
    assert float(frame.std()) > 1.0
