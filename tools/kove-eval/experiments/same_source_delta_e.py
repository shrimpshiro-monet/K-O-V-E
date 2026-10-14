"""Is the colour gap a grade problem or a footage-selection problem? Both — sized.

The scorecard's `color_delta_e_mean` compares the reference against the output at
the same timestamp and gets 20-32 dE. That number mixes two very different causes:

* the **grade** — the output is not graded like the reference, and
* the **material** — the output is showing a different pack at that timestamp.

This script separates them. Both sides' clip choices are recoverable without a
render:

* the reference's, by re-running the builder's own pure functions
  (`build._shot_plan` + `build._pick_source`), which is why the golden set must
  stay deterministic (F19);
* the output's, from the snapped plan's `sourceVideoId`, which names the pack.

Then every sampled timestamp is bucketed **same-pack** or **different-pack** and
dE is reported per bucket.

RESULT (run 2026-10-14, `runs/step1-detector`, 0.25s sampling):

    reference        sampled same-pack diff-pack  dE same  dE diff  p95 same
    pulse-fast            92        30        62     18.9     39.9      30.0
    cinematic-slow       102        70        32     12.6     37.2      44.3
    doc-natural          104        95         9     18.4     41.7      31.4
    social-vertical       96        28        68     20.0     39.2      33.7
    text-forward         100        34        66      8.8     40.1      38.0

Both causes are real and large. Showing the wrong pack roughly **doubles to
quadruples** dE (2.0x-4.6x), so footage selection is the single biggest
contributor — but same-pack dE is still **8.8-20.0**, well above the ~5 dE
people notice, so the grade is wrong too and `lab-transfer` is still the right
fix. Fixing only the grade would leave roughly half the gap.

Internal check: weighting the two buckets reproduces the scorecard's own
aggregate almost exactly on two references (text-forward 29.5 vs 29.3 measured;
doc-natural 20.4 vs 20.2) and closely on the rest, so the buckets genuinely
explain the aggregate rather than slicing it arbitrarily.

CAVEAT, stated because it bounds the claim: "same pack" is not "same source
time". Within one pack the output may be showing a different sub-shot, so
same-pack dE is an **upper bound** on the grade error, not a measurement of it.
Tightening it means also requiring overlapping source ranges — worth doing when
this becomes the V3/V6 metric.

This should become a `kove-eval sources` subcommand with a proper test when the
footage-selection metric (V3/V6) is built; it is kept here as an experiment so
the number in the log is reproducible in the meantime.

Usage:  PYTHONPATH=tools/kove-eval python experiments/same_source_delta_e.py
"""

from __future__ import annotations

import bisect
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kove_eval import bridge, metrics, pipeline  # noqa: E402
from kove_eval.build import _golden_media_paths, _pick_source, _shot_plan  # noqa: E402
from kove_eval.goldens import FAMILIES  # noqa: E402
from kove_eval.media import FrameReader  # noqa: E402

ROOT = Path("evaluation-files/craft")
RUN = ROOT / "runs/step1-detector"


def reference_shot_packs(
    family, beat: float, pack_ids: list[str]
) -> list[tuple[float, float, str]]:
    """(start, end, pack_id) per reference shot, from the builder's own functions."""
    lengths = _shot_plan(family, beat)
    spans: list[tuple[float, float, str]] = []
    cursor = 0.0
    for index, length in enumerate(lengths):
        pack_id, _in, _out = _pick_source(index, pack_ids, length)
        spans.append((cursor, cursor + length, pack_id))
        cursor += length
    return spans


def output_shot_packs(run_dir: Path, style) -> list[tuple[float, float, str]]:
    """(start, end, pack_id) per rendered shot, from the snapped plan."""
    _timeline, plan = pipeline.feed_for_style(style)
    packs, track, _voice = _golden_media_paths()
    snap = bridge.snap_plan(
        plan,
        pipeline.segment_map_for(style, track, sorted(packs)),
        cut_offset_seconds=style.beat_offset_seconds,
        reference_shot_lengths_in_beats=style.shot_lengths_beats or None,
    )
    spans: list[tuple[float, float, str]] = []
    cursor = 0.0
    for segment in snap["plan"]["segments"]:
        duration = segment["sourceEndTime"] - segment["sourceStartTime"]
        spans.append((cursor, cursor + duration, segment["sourceVideoId"]))
        cursor += duration
    return spans


def pack_at(spans: list[tuple[float, float, str]], time_s: float) -> str | None:
    starts = [span[0] for span in spans]
    index = bisect.bisect_right(starts, time_s) - 1
    if index < 0:
        return None
    start, end, pack = spans[index]
    return pack if start <= time_s < end else None


def main() -> int:
    run_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else RUN
    header = (
        f"{'reference':16} {'sampled':>7} {'same-pack':>9} {'diff-pack':>9} "
        f"{'dE same':>8} {'dE diff':>8} {'p95 same':>9} {'weighted':>9} {'scorecard':>10}"
    )
    print(header)
    for family in FAMILIES:
        ground_truth = json.loads(
            (ROOT / "references" / f"{family.id}.groundtruth.json").read_text()
        )
        beat = 60.0 / ground_truth["bpm"]
        reference_spans = reference_shot_packs(family, beat, ground_truth["pack_ids"])

        style = pipeline.analyze_reference(
            Path(ground_truth["video"]), cache_dir=run_dir / ".cache", force=False
        )
        output_spans = output_shot_packs(run_dir, style)
        output_path = run_dir / "outputs" / f"{family.id}.mp4"

        same: list[float] = []
        different: list[float] = []
        with FrameReader(ground_truth["video"]) as ref_reader, FrameReader(
            output_path
        ) as out_reader:
            for sample in np.arange(0.5, min(ground_truth["duration"], style.duration) - 0.5, 0.25):
                time_s = float(sample)
                reference_pack = pack_at(reference_spans, time_s)
                output_pack = pack_at(output_spans, time_s)
                ref_frame = ref_reader.frame_at(time_s)
                out_frame = out_reader.frame_at(time_s)
                if ref_frame is None or out_frame is None:
                    continue
                lab_a = metrics.bgr_to_lab(ref_frame)
                lab_b = metrics.bgr_to_lab(out_frame)
                distance = float(
                    np.median(
                        metrics.delta_e_2000_pixels(lab_a.reshape(-1, 3), lab_b.reshape(-1, 3))
                    )
                )
                if reference_pack is None or output_pack is None:
                    continue
                (same if reference_pack == output_pack else different).append(distance)

        def median(values: list[float]) -> str:
            return f"{np.median(values):.1f}" if values else "—"

        def p95(values: list[float]) -> str:
            return f"{np.percentile(values, 95):.1f}" if values else "—"

        all_values = same + different
        weighted = f"{np.mean(all_values):.1f}" if all_values else "—"
        scorecard = json.loads((run_dir / "scorecard.json").read_text())
        measured = "—"
        for entry in scorecard["references"]:
            if entry["reference_id"] == family.id:
                for row in entry["metrics"]:
                    if row["name"] == "color_delta_e_mean":
                        measured = f"{row['output']:.1f}"
        print(
            f"{family.id:16} {len(all_values):>7} {len(same):>9} {len(different):>9} "
            f"{median(same):>8} {median(different):>8} {p95(same):>9} {weighted:>9} {measured:>10}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
