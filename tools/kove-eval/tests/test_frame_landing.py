"""A cut only reaches the file on a frame boundary. The plan has to know that.

The renderer shows frame `k` for every time in `[k/fps, (k+1)/fps)`, so a cut
planned anywhere between two frames is played by the *next* one. That is the
whole finding of sub-step 3b: the renderer is exact, and the plan was asking for
instants the file cannot express, at a median cost of 22ms at 25fps — over half
the 40ms tolerance the edit is judged with.

These tests pin the convention that the plan-side fix (`snapPlanToBeatGrid` with
`options.fps`) is written against, using the renderer itself rather than a model
of it:

* a cut exactly at `k/fps` is served by frame `k`;
* the same instant reached by a running sum of durations (what a plan actually
  stores) can land a float ulp *above* the boundary — and is then served by
  frame `k+1`;
* a cut one microsecond below the boundary — the guard the snapper leaves — is
  served by frame `k`, so the guard is not decoration;
* a cut a whole extra frame late is served by frame `k+1`, whatever its cause.

If the renderer's frame timing ever changes, this is the file that says so.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from kove_eval.compositor import Clip, Timeline, render_timeline
from kove_eval.media import FrameReader, write_video_from_frames

FPS = 25.0
FRAME = 40  # 1.6s, a frame boundary at 25fps
BRIGHT = 120.0


def _source_clips(tmp_path: Path, seconds: float = 3.0) -> tuple[Path, Path]:
    """Two flat clips, dark then bright: the only difference in the file is the cut."""
    frames = int(seconds * FPS)
    dark = tmp_path / "dark.mp4"
    bright = tmp_path / "bright.mp4"
    write_video_from_frames(
        [np.full((64, 64, 3), 20, dtype=np.uint8)] * frames, FPS, dark
    )
    write_video_from_frames(
        [np.full((64, 64, 3), 220, dtype=np.uint8)] * frames, FPS, bright
    )
    return dark, bright


def _durations(*parts: float) -> float:
    """The cut time a plan stores: a running sum of shot durations, in order."""
    total = 0.0
    for part in parts:
        total += part
    return total


def _render(tmp_path: Path, first_shot: float, timeline_start: float | None = None) -> Path:
    """Render a two-shot timeline whose cut is at `first_shot` seconds."""
    dark, bright = _source_clips(tmp_path)
    start = first_shot if timeline_start is None else timeline_start
    timeline = Timeline(
        clips=[
            Clip(source=str(dark), source_start=0.0, source_end=first_shot, timeline_start=0.0),
            Clip(source=str(bright), source_start=0.0, source_end=2.0, timeline_start=start),
        ],
        fps=FPS,
        size=(64, 64),
    )
    out = tmp_path / "out.mp4"
    render_timeline(timeline, out)
    return out


def _first_bright_frame(path: Path) -> int:
    """Index of the first frame that shows the incoming shot."""
    with FrameReader(path, width=0) as reader:
        frames = reader.frames_between(0.0, 2.0, 1.0 / FPS)
    for index, (_timestamp, frame) in enumerate(frames):
        if float(frame.mean()) > BRIGHT:
            return index
    raise AssertionError("the incoming shot never appeared")


def test_a_cut_on_a_frame_boundary_is_served_by_that_frame(tmp_path: Path) -> None:
    assert _first_bright_frame(_render(tmp_path, FRAME / FPS)) == FRAME


def test_a_cut_a_whole_frame_late_is_one_frame_late(tmp_path: Path) -> None:
    """The reader's finding, reproduced at the renderer: +40ms is one frame."""
    assert _first_bright_frame(_render(tmp_path, (FRAME + 1) / FPS)) == FRAME + 1


def test_a_cut_between_frames_is_served_by_the_next_one(tmp_path: Path) -> None:
    """Why the fix is needed at all: half a frame of plan, a whole frame of file."""
    betweeen = (FRAME + 0.5) / FPS
    assert _first_bright_frame(_render(tmp_path, betweeen)) == FRAME + 1


# Five shots, each a whole number of frames at 25fps, adding up to 1.6s — frame
# 40. In binary they add up to 1.6000000000000003: one ulp *above* the frame.
WHOLE_FRAME_SHOTS = (0.04, 0.12, 0.56, 0.56, 0.32)


def test_a_sum_landing_above_the_boundary_costs_a_frame(tmp_path: Path) -> None:
    """The trap the guard exists for.

    A plan's cut time is a running sum of shot durations, and a sum of five
    whole-frame shots can still land a float ulp above the boundary it was aimed
    at. Landing above is not a rounding detail: the renderer serves the next
    frame, and the cut is 40ms late. Exact intentions are not enough.
    """
    above = _durations(*WHOLE_FRAME_SHOTS)
    assert above > FRAME / FPS  # the overshoot is real, not hypothetical
    assert _first_bright_frame(_render(tmp_path, above, timeline_start=above)) == FRAME + 1


def test_the_guard_puts_the_same_sum_back_on_its_frame(tmp_path: Path) -> None:
    """One microsecond below the boundary is enough, and costs nothing visible."""
    guard = 1e-6
    guarded = _durations(*(shot - guard for shot in WHOLE_FRAME_SHOTS))
    assert guarded < FRAME / FPS
    assert _first_bright_frame(_render(tmp_path, guarded, timeline_start=guarded)) == FRAME
    # 1us early is 0.0025% of a frame — below every metric's resolution.
    assert FRAME / FPS - guarded < 1e-5


def test_rounding_a_cut_to_microseconds_keeps_it_on_its_frame(tmp_path: Path) -> None:
    """The harness rounds clip starts to 6 decimals; the guard has to survive it."""
    guarded = FRAME / FPS - 1e-6
    rounded = round(guarded, 6)
    assert _first_bright_frame(_render(tmp_path, rounded, timeline_start=rounded)) == FRAME
