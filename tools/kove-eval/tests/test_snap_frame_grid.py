"""The frame grid has to survive the bridge, not just the unit tests.

`snapPlanToBeatGrid` aligns cuts to the output's frame rate, but the harness
reaches it through a bridge: a job file, the repo's own vitest, and whatever the
job interface does with the options. If `fps` is dropped on the way across, the
commander silently renders an unaligned plan and a score run looks like a
negative result — the expensive kind of bug, because it looks like data.

So this test drives the real production snapper through the real bridge, the way
`cli build` does, and requires the cuts to land on frames.
"""

from __future__ import annotations

from kove_eval import bridge

FPS = 25.0
# 120 BPM, and 30ms early: a grid that does *not* sit on 25fps frames (0.47s is
# frame 11.75), so without the frame grid every cut is between frames.
GRID = {"beats": [round(0.03 + 0.5 * step, 4) for step in range(40)], "source": "music-bed",
        "beatPeriodSeconds": 0.5, "offsetSeconds": -0.03}


def _plan() -> dict:
    """Six one-second shots of one video — cuts every 1s, none of them on a frame."""
    segments = []
    for index in range(6):
        segments.append(
            {
                "sourceVideoId": "video-1",
                "sourceStartTime": round(index * 1.03, 4),
                "sourceEndTime": round((index + 1) * 1.03, 4),
                "effects": [],
                "rationale": f"shot {index}",
            }
        )
    return {
        "segments": segments,
        "textElements": [],
        "effects": [],
        "transitions": [],
        "audioDecisions": [],
        "metadata": {
            "targetDuration": 6.18,
            "targetPlatform": "tiktok",
            "genre": "social-reel",
            "pacing": "fast",
            "rationale": "frame-alignment bridge test",
        },
    }


def _segment_map() -> dict:
    return {
        "videos": [
            {
                "videoId": "video-1",
                "duration": 60.0,
                "segments": [
                    {
                        "id": "video-1-s1",
                        "startTime": 0.0,
                        "endTime": 60.0,
                        "description": "footage",
                        "sceneType": "b-roll",
                        "motionLevel": "medium",
                        "hasDialogue": False,
                        "visualContent": "footage",
                        "confidence": 0.9,
                        "beatTimestamps": GRID["beats"],
                    }
                ],
            }
        ]
    }


def _cut_positions(plan: dict) -> list[float]:
    """Cut times as the renderer walks them: the running sum of the spans."""
    cursor = 0.0
    positions = []
    segments = plan["segments"]
    for index, segment in enumerate(segments):
        cursor += max(0.0, segment["sourceEndTime"] - segment["sourceStartTime"])
        if index < len(segments) - 1:
            positions.append(cursor)
    return positions


def _on_frame(position: float, fps: float) -> bool:
    """True when the renderer serves this cut on the frame the plan names.

    The renderer's own rule: frame `k` runs while `k/fps <= t < (k+1)/fps`, so a
    cut has to sit at or below the boundary it is planned on — not above it.
    """
    index = round(position * fps)
    boundary = index / fps
    return 0 < boundary - position < 1e-3


def test_the_bridge_applies_the_frame_rate() -> None:
    plan = _plan()
    segment_map = _segment_map()

    aligned = bridge.snap_plan(plan, segment_map, cut_offset_seconds=-0.03, fps=FPS)
    report = aligned["report"]

    assert report["fps"] == FPS
    assert report["frameAlignedCuts"] == report["snappedCuts"] == 5
    positions = _cut_positions(aligned["plan"])
    assert positions, "the plan has cuts to align"
    for position in positions:
        assert _on_frame(position, FPS), f"cut at {position} is not on a 25fps frame"
    assert report["maxAbsFrameShiftSeconds"] <= 0.5 / FPS


def test_without_the_frame_rate_the_bridge_leaves_cuts_between_frames() -> None:
    """The control: the same snap without `fps` really does miss the frames.

    Without this the test above could pass on a plan that never needed aligning.
    """
    aligned = bridge.snap_plan(_plan(), _segment_map(), cut_offset_seconds=-0.03)
    assert aligned["report"]["fps"] is None
    assert aligned["report"]["frameAlignedCuts"] == 0

    positions = _cut_positions(aligned["plan"])
    assert any(not _on_frame(position, FPS) for position in positions)
